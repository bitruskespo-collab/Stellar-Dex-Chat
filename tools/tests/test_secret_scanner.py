from __future__ import annotations

import contextlib
import datetime as dt
import io
import json
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import secret_scanner as scanner  # noqa: E402

TODAY = dt.date(2026, 11, 20)
OWNER = "leojay-net"


def seed_value() -> str:
    return "S" + "A" * 55


def github_value() -> str:
    return "ghp_" + "B" * 36


def generic_value() -> str:
    return "abcdefghijklmnopqrstuvwxyz0123456789"


def policy_payload(**overrides):
    payload = {
        "version": "1.0",
        "allowedOwners": [OWNER, "security-team"],
        "maxExpiryDays": 90,
        "exceptions": [],
    }
    payload.update(overrides)
    return payload


def exception_payload(fingerprint: str, **overrides):
    payload = {
        "id": "EXC-001",
        "ruleId": "stellar-secret-seed",
        "path": "fixtures/*",
        "fingerprint": fingerprint,
        "owner": OWNER,
        "approvedAt": (TODAY - dt.timedelta(days=1)).isoformat(),
        "expiresAt": (TODAY + dt.timedelta(days=30)).isoformat(),
        "justification": "Synthetic fixture used only by automated tests.",
    }
    payload.update(overrides)
    return payload


@contextlib.contextmanager
def captured():
    out = io.StringIO()
    err = io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        yield out, err


class ExceptionPolicyTests(unittest.TestCase):
    def test_valid_exception_exempts_matching_finding(self):
        secret = seed_value()
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "policy.json"
            path.write_text(
                json.dumps(
                    policy_payload(
                        exceptions=[exception_payload(scanner.compute_fingerprint(secret))]
                    )
                ),
                encoding="utf-8",
            )
            policy = scanner.ExceptionPolicy(path, current_date=TODAY)
            self.assertEqual([], policy.errors)
            self.assertEqual([], policy.expired)
            sweep = scanner.SecretScanner(policy)
            findings = sweep.scan_text(secret, "fixtures/fake.env")
            self.assertEqual(1, len(findings))
            self.assertTrue(findings[0].exempted)
            self.assertEqual("EXC-001", findings[0].exception_id)
            self.assertTrue(policy.exceptions[0].used)

    def test_unauthorized_owner_blocks_exemption(self):
        secret = seed_value()
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "policy.json"
            path.write_text(
                json.dumps(
                    policy_payload(
                        exceptions=[
                            exception_payload(
                                scanner.compute_fingerprint(secret), owner="untrusted-user"
                            )
                        ]
                    )
                ),
                encoding="utf-8",
            )
            policy = scanner.ExceptionPolicy(path, current_date=TODAY)
            self.assertTrue(any("allowedOwners" in error for error in policy.errors))
            sweep = scanner.SecretScanner(policy)
            findings = sweep.scan_text(secret, "fixtures/fake.env")
            self.assertFalse(findings[0].exempted)
            with captured() as (out, err):
                code = scanner.report_results(sweep, policy)
            self.assertEqual(1, code)
            self.assertNotIn(secret, out.getvalue() + err.getvalue())

    def test_expired_exception_fails_and_does_not_exempt(self):
        secret = seed_value()
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "policy.json"
            path.write_text(
                json.dumps(
                    policy_payload(
                        exceptions=[
                            exception_payload(
                                scanner.compute_fingerprint(secret),
                                approvedAt="2026-09-01",
                                expiresAt="2026-10-01",
                            )
                        ]
                    )
                ),
                encoding="utf-8",
            )
            policy = scanner.ExceptionPolicy(path, current_date=TODAY)
            self.assertEqual(1, len(policy.expired))
            sweep = scanner.SecretScanner(policy)
            findings = sweep.scan_text(secret, "fixtures/fake.env")
            self.assertFalse(findings[0].exempted)
            with captured() as (out, err):
                code = scanner.report_results(sweep, policy)
            self.assertEqual(1, code)
            self.assertIn("EXC-001", err.getvalue())
            self.assertNotIn(secret, out.getvalue() + err.getvalue())

    def test_exception_duration_over_max_is_rejected(self):
        secret = seed_value()
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "policy.json"
            path.write_text(
                json.dumps(
                    policy_payload(
                        exceptions=[
                            exception_payload(
                                scanner.compute_fingerprint(secret),
                                approvedAt="2026-10-01",
                                expiresAt="2027-01-15",
                            )
                        ]
                    )
                ),
                encoding="utf-8",
            )
            policy = scanner.ExceptionPolicy(path, current_date=TODAY)
            self.assertTrue(any("maxExpiryDays" in error for error in policy.errors))
            self.assertEqual([], policy.exceptions)

    def test_future_approval_is_rejected(self):
        secret = seed_value()
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "policy.json"
            path.write_text(
                json.dumps(
                    policy_payload(
                        exceptions=[
                            exception_payload(
                                scanner.compute_fingerprint(secret),
                                approvedAt="2026-12-01",
                                expiresAt="2026-12-15",
                            )
                        ]
                    )
                ),
                encoding="utf-8",
            )
            policy = scanner.ExceptionPolicy(path, current_date=TODAY)
            self.assertTrue(any("future" in error for error in policy.errors))

    def test_plaintext_secret_field_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "policy.json"
            payload = policy_payload()
            payload["secretValue"] = "not-a-real-value"
            path.write_text(json.dumps(payload), encoding="utf-8")
            policy = scanner.ExceptionPolicy(path, current_date=TODAY)
            self.assertTrue(any("forbidden" in error for error in policy.errors))

    def test_duplicate_exception_ids_are_rejected(self):
        fingerprint = scanner.compute_fingerprint(seed_value())
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "policy.json"
            path.write_text(
                json.dumps(
                    policy_payload(
                        exceptions=[
                            exception_payload(fingerprint),
                            exception_payload(fingerprint),
                        ]
                    )
                ),
                encoding="utf-8",
            )
            policy = scanner.ExceptionPolicy(path, current_date=TODAY)
            self.assertTrue(any("duplicate" in error for error in policy.errors))


class ScannerTests(unittest.TestCase):
    def test_detection_reports_fingerprint_only(self):
        secret = seed_value()
        policy = scanner.ExceptionPolicy(None, current_date=TODAY)
        sweep = scanner.SecretScanner(policy)
        findings = sweep.scan_text(f"SEED={secret}\n", "fixtures/fake.env")
        self.assertEqual(1, len(findings))
        self.assertEqual("stellar-secret-seed", findings[0].rule_id)
        with captured() as (out, err):
            code = scanner.report_results(sweep, policy)
        output = out.getvalue() + err.getvalue()
        self.assertEqual(1, code)
        self.assertIn(scanner.compute_fingerprint(secret), output)
        self.assertNotIn(secret, output)
        self.assertIn("Secret leak response steps", output)

    def test_placeholders_and_environment_references_are_ignored(self):
        policy = scanner.ExceptionPolicy(None, current_date=TODAY)
        sweep = scanner.SecretScanner(policy)
        text = "SEED=${STELLAR_SECRET_SEED}\nAPI_KEY=example-placeholder-value\n"
        self.assertEqual([], sweep.scan_text(text, "fixtures/fake.env"))

    def test_github_token_rule_detects_without_disclosing(self):
        token = github_value()
        policy = scanner.ExceptionPolicy(None, current_date=TODAY)
        sweep = scanner.SecretScanner(policy)
        findings = sweep.scan_text(f"TOKEN={token}\n", "fixtures/fake.env")
        self.assertEqual(["github-token"], [finding.rule_id for finding in findings])
        with captured() as (out, err):
            scanner.report_results(sweep, policy)
        self.assertNotIn(token, out.getvalue() + err.getvalue())

    def test_git_diff_scans_only_added_lines(self):
        added = seed_value()
        removed = "S" + "C" * 55
        diff = "\n".join(
            [
                "diff --git a/fixtures/fake.env b/fixtures/fake.env",
                "--- a/fixtures/fake.env",
                "+++ b/fixtures/fake.env",
                "@@ -1,2 +1,2 @@",
                f"-REMOVED={removed}",
                f"+ADDED={added}",
            ]
        )
        policy = scanner.ExceptionPolicy(None, current_date=TODAY)
        sweep = scanner.SecretScanner(policy)
        findings = sweep.scan_git_diff(diff)
        self.assertEqual(1, len(findings))
        self.assertEqual(1, findings[0].line)
        self.assertNotIn(scanner.compute_fingerprint(removed), {f.fingerprint for f in findings})

    def test_zip_artifact_scan_skips_unsafe_members(self):
        secret = generic_value()
        with tempfile.TemporaryDirectory() as tmp:
            archive_path = Path(tmp) / "release.zip"
            with zipfile.ZipFile(archive_path, "w") as archive:
                archive.writestr("sbom.cdx.json", f'{{"apiKey": "{secret}"}}')
                archive.writestr("../escape.txt", f"SEED={seed_value()}")
            policy = scanner.ExceptionPolicy(None, current_date=TODAY)
            sweep = scanner.SecretScanner(policy)
            findings = sweep.scan_artifacts(archive_path)
            self.assertEqual(1, len(findings))
            self.assertIn("sbom.cdx.json", findings[0].location)
            self.assertNotIn("escape.txt", findings[0].location)

    def test_env_example_flags_live_secret_and_allows_placeholder(self):
        secret = generic_value()
        with tempfile.TemporaryDirectory() as tmp:
            env = Path(tmp) / ".env.example"
            env.write_text(
                f"API_KEY=placeholder-value\nPAYSTACK_SECRET_KEY=\"{secret}\"\n",
                encoding="utf-8",
            )
            policy = scanner.ExceptionPolicy(None, current_date=TODAY)
            sweep = scanner.SecretScanner(policy)
            findings = sweep.check_env_examples(Path(tmp))
            self.assertEqual(1, len(findings))
            self.assertEqual("generic-credential-assignment", findings[0].rule_id)
            with captured() as (out, err):
                scanner.report_results(sweep, policy)
            self.assertNotIn(secret, out.getvalue() + err.getvalue())

    def test_cli_json_output_never_contains_detected_value(self):
        secret = github_value()
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "fixtures"
            target.mkdir()
            (target / "fake.txt").write_text(f"TOKEN={secret}\n", encoding="utf-8")
            policy_path = Path(tmp) / "policy.json"
            policy_path.write_text(json.dumps(policy_payload()), encoding="utf-8")
            with captured() as (out, err):
                code = scanner.main(
                    ["--path", str(target), "--exceptions", str(policy_path), "--json"]
                )
            raw = out.getvalue() + err.getvalue()
            self.assertEqual(1, code)
            self.assertNotIn(secret, raw)
            payload = json.loads(out.getvalue())
            self.assertFalse(payload["passed"])
            self.assertEqual(1, payload["activeFindingsCount"])

    def test_invalid_current_date_is_usage_error(self):
        with captured() as (out, err):
            code = scanner.main(["--current-date", "20-11-2026"])
        self.assertEqual(2, code)
        self.assertIn("YYYY-MM-DD", err.getvalue())


if __name__ == "__main__":
    unittest.main()
