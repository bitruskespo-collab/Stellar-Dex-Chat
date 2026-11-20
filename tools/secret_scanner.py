#!/usr/bin/env python3
from __future__ import annotations

import argparse
import datetime as dt
import fnmatch
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
import tarfile
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Pattern, Sequence, Set, Tuple

MAX_SCAN_FILE_BYTES = 2 * 1024 * 1024
MAX_ARCHIVE_MEMBER_BYTES = 8 * 1024 * 1024
MAX_ARCHIVE_MEMBERS = 512

FORBIDDEN_POLICY_KEYS = {
    "secret",
    "secretvalue",
    "secret_value",
    "plaintext",
    "rawvalue",
    "raw_value",
    "tokenvalue",
    "token_value",
    "passwordvalue",
    "password_value",
}

IGNORED_DIRECTORIES = {
    ".git",
    ".svn",
    ".hg",
    ".next",
    ".turbo",
    ".cache",
    ".idea",
    ".vscode",
    "__pycache__",
    "build",
    "coverage",
    "dist",
    "node_modules",
    "playwright-report",
    "target",
    "test-results",
}

IGNORED_EXTENSIONS = {
    ".avi",
    ".bmp",
    ".eot",
    ".gif",
    ".gz",
    ".ico",
    ".jpeg",
    ".jpg",
    ".lock",
    ".mp3",
    ".mp4",
    ".pdf",
    ".png",
    ".pyc",
    ".svg",
    ".tgz",
    ".ttf",
    ".wasm",
    ".webp",
    ".woff",
    ".woff2",
    ".zip",
}

PLACEHOLDER_HINTS = (
    "your-",
    "your_",
    "changeme",
    "change-me",
    "placeholder",
    "example",
    "xxxx",
    "dummy",
    "test-",
    "test_",
    "redacted",
    "mock",
    "replace_me",
    "replace-me",
    "sample",
    "00000000",
    "fill_in",
    "fill-in",
    "localhost",
    "insert_",
    "insert-",
    "todo",
    "not-a-real",
)


@dataclass(frozen=True)
class SecretRule:
    rule_id: str
    description: str
    severity: str
    pattern: Pattern[str]
    value_group: int = 0


RULES: Tuple[SecretRule, ...] = (
    SecretRule(
        "stellar-secret-seed",
        "Stellar Ed25519 secret seed",
        "CRITICAL",
        re.compile(r"\bS[ABCDEFGHIJKLMNOPQRSTUVWXYZ234567]{55}\b"),
    ),
    SecretRule(
        "pem-private-key",
        "PEM private key header",
        "CRITICAL",
        re.compile(r"-----BEGIN (?:[A-Z0-9_-]+ )?PRIVATE KEY-----"),
    ),
    SecretRule(
        "github-token",
        "GitHub personal access or OAuth token",
        "CRITICAL",
        re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9_]{36,}|github_pat_[A-Za-z0-9_]{82,})\b"),
    ),
    SecretRule(
        "aws-access-key-id",
        "AWS access key id",
        "HIGH",
        re.compile(r"\b(?:AKIA|ABIA|ACCA|ASIA)[0-9A-Z]{16}\b"),
    ),
    SecretRule(
        "aws-secret-access-key",
        "AWS secret access key assignment",
        "CRITICAL",
        re.compile(
            r"(?i)(?:aws_secret_access_key|aws_secret_key)\s*[:=]\s*[\"']?([A-Za-z0-9/+=]{40})[\"']?"
        ),
        1,
    ),
    SecretRule(
        "payment-provider-secret",
        "Payment provider API secret",
        "CRITICAL",
        re.compile(r"\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{16,}\b"),
    ),
    SecretRule(
        "google-api-key",
        "Google API key",
        "HIGH",
        re.compile(r"\bAIza[0-9A-Za-z_-]{35}\b"),
    ),
    SecretRule(
        "slack-token",
        "Slack bot or user token",
        "HIGH",
        re.compile(r"\bxox[baprs]-[0-9A-Za-z]{10,48}\b"),
    ),
    SecretRule(
        "generic-credential-assignment",
        "High-entropy credential assignment",
        "HIGH",
        re.compile(
            r"(?i)(?:api[_-]?key|secret[_-]?key|auth[_-]?token|access[_-]?token|"
            r"client[_-]?secret|jwt[_-]?secret)[\"']?\s*[:=]\s*[\"']([^\"'\r\n\s]{20,})[\"']"
        ),
        1,
    ),
)


@dataclass
class Finding:
    rule_id: str
    description: str
    severity: str
    location: str
    line: int
    fingerprint: str
    length: int
    exempted: bool = False
    exception_id: Optional[str] = None


@dataclass
class ExceptionEntry:
    id: str
    rule_id: str
    path: str
    fingerprint: str
    owner: str
    approved_at: dt.date
    expires_at: dt.date
    justification: str
    used: bool = False


class ScanError(Exception):
    pass


def compute_fingerprint(value: str) -> str:
    return "sha256:" + hashlib.sha256(value.strip().encode("utf-8")).hexdigest()


def is_placeholder(value: str) -> bool:
    cleaned = value.strip()
    if not cleaned:
        return True
    if re.fullmatch(r"\$\{[A-Za-z_][A-Za-z0-9_]*\}", cleaned):
        return True
    if re.fullmatch(r"\$\([A-Za-z_][A-Za-z0-9_]*\)", cleaned):
        return True
    if re.fullmatch(r"\$[A-Za-z_][A-Za-z0-9_]*", cleaned):
        return True
    if re.fullmatch(r"%[A-Za-z_][A-Za-z0-9_]*%", cleaned):
        return True
    if re.match(r"^(?:process\.env\.|os\.environ|env::var)", cleaned):
        return True
    lower = cleaned.lower()
    if any(hint in lower for hint in PLACEHOLDER_HINTS):
        return True
    if len(lower) > 8 and len(set(lower)) == 1:
        return True
    if len(lower) > 8 and set(lower).issubset({"x", "0", "-", "_", "*", ".", "a"}):
        return True
    return False


def parse_date(value: Any, label: str, errors: List[str]) -> Optional[dt.date]:
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        errors.append(f"{label} must use YYYY-MM-DD format.")
        return None
    try:
        return dt.date.fromisoformat(value)
    except ValueError:
        errors.append(f"{label} is not a valid calendar date.")
        return None


def clean_string(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


class ExceptionPolicy:
    def __init__(
        self,
        path: Optional[Path],
        current_date: Optional[dt.date] = None,
        max_expiry_days: int = 90,
    ) -> None:
        self.path = path
        self.current_date = current_date or dt.date.today()
        self.default_max_expiry_days = max_expiry_days
        self.max_expiry_days = max_expiry_days
        self.allowed_owners: Set[str] = set()
        self.exceptions: List[ExceptionEntry] = []
        self.errors: List[str] = []
        self.expired: List[Dict[str, str]] = []
        if path is not None and path.is_file():
            self._load(path)

    def _load(self, path: Path) -> None:
        try:
            raw = path.read_text(encoding="utf-8")
        except OSError:
            self.errors.append(f"Unable to read exception policy: {path}")
            return
        try:
            data = json.loads(raw)
        except json.JSONDecodeError as exc:
            self.errors.append(
                f"Invalid JSON in exception policy at line {exc.lineno}, column {exc.colno}."
            )
            return
        self._reject_forbidden_keys(data)
        if not isinstance(data, dict):
            self.errors.append("Exception policy root must be a JSON object.")
            return
        if data.get("version") != "1.0":
            self.errors.append("Exception policy version must be '1.0'.")
        owners = data.get("allowedOwners")
        if not isinstance(owners, list) or not owners:
            self.errors.append("allowedOwners must be a non-empty array.")
        elif any(not clean_string(owner) for owner in owners):
            self.errors.append("allowedOwners entries must be non-empty strings.")
        else:
            self.allowed_owners = {clean_string(owner).lower() for owner in owners}
        configured_max = data.get("maxExpiryDays", self.default_max_expiry_days)
        if (
            isinstance(configured_max, int)
            and not isinstance(configured_max, bool)
            and 1 <= configured_max <= 365
        ):
            self.max_expiry_days = configured_max
        else:
            self.errors.append("maxExpiryDays must be an integer between 1 and 365.")
        entries = data.get("exceptions")
        if not isinstance(entries, list):
            self.errors.append("exceptions must be an array.")
            return
        seen_ids: Set[str] = set()
        for index, entry in enumerate(entries):
            self._load_entry(entry, index, seen_ids)

    def _reject_forbidden_keys(self, value: Any) -> None:
        if isinstance(value, dict):
            for key, nested in value.items():
                if isinstance(key, str) and key.lower() in FORBIDDEN_POLICY_KEYS:
                    self.errors.append(
                        f"Policy field '{key}' is forbidden; plaintext secret values must not be stored."
                    )
                self._reject_forbidden_keys(nested)
        elif isinstance(value, list):
            for nested in value:
                self._reject_forbidden_keys(nested)

    def _load_entry(self, entry: Any, index: int, seen_ids: Set[str]) -> None:
        if not isinstance(entry, dict):
            self.errors.append(f"Exception at index {index} must be an object.")
            return
        entry_id = clean_string(entry.get("id"))
        label = entry_id or f"index {index}"
        valid = True
        if not re.fullmatch(r"[A-Za-z0-9_-]+", entry_id):
            self.errors.append(f"[{label}] id must contain only letters, digits, '-' or '_'.")
            valid = False
        elif entry_id in seen_ids:
            self.errors.append(f"[{label}] duplicate exception id.")
            valid = False
        seen_ids.add(entry_id)

        rule_id = clean_string(entry.get("ruleId"))
        path_pattern = clean_string(entry.get("path"))
        fingerprint = clean_string(entry.get("fingerprint"))
        owner = clean_string(entry.get("owner"))
        justification = clean_string(entry.get("justification"))
        if not rule_id:
            self.errors.append(f"[{label}] ruleId is required.")
            valid = False
        if not self._valid_path_pattern(path_pattern):
            self.errors.append(f"[{label}] path must be a repository-relative glob without '..'.")
            valid = False
        if not (fingerprint == "*" or re.fullmatch(r"sha256:[0-9a-fA-F]{64}", fingerprint)):
            self.errors.append(
                f"[{label}] fingerprint must be 'sha256:<64 hex chars>' or '*'."
            )
            valid = False
        if not clean_string(entry.get("owner")) or owner.lower() not in self.allowed_owners:
            self.errors.append(
                f"[{label}] owner must be listed in allowedOwners."
            )
            valid = False
        if len(justification) < 15:
            self.errors.append(f"[{label}] justification must be at least 15 characters.")
            valid = False

        approved_at = parse_date(entry.get("approvedAt"), f"[{label}] approvedAt", self.errors)
        expires_at = parse_date(entry.get("expiresAt"), f"[{label}] expiresAt", self.errors)
        if approved_at is None or expires_at is None:
            return
        if approved_at > self.current_date:
            self.errors.append(f"[{label}] approvedAt cannot be in the future.")
            valid = False
        if expires_at <= approved_at:
            self.errors.append(f"[{label}] expiresAt must be after approvedAt.")
            valid = False
        if (expires_at - approved_at).days > self.max_expiry_days:
            self.errors.append(
                f"[{label}] exception duration exceeds maxExpiryDays ({self.max_expiry_days})."
            )
            valid = False
        if expires_at < self.current_date:
            self.expired.append(
                {"id": entry_id, "owner": owner, "expiresAt": expires_at.isoformat()}
            )
        if not valid:
            return
        self.exceptions.append(
            ExceptionEntry(
                id=entry_id,
                rule_id=rule_id,
                path=path_pattern,
                fingerprint=fingerprint,
                owner=owner,
                approved_at=approved_at,
                expires_at=expires_at,
                justification=justification,
            )
        )

    @staticmethod
    def _valid_path_pattern(pattern: str) -> bool:
        if not pattern or pattern.startswith("/") or re.match(r"^[A-Za-z]:", pattern):
            return False
        normalized = pattern.replace("\\", "/")
        return ".." not in normalized.split("/")

    def match(self, finding: Finding) -> Optional[ExceptionEntry]:
        location = finding.location.replace("\\", "/")
        if location.startswith("./"):
            location = location[2:]
        for entry in self.exceptions:
            if self.current_date > entry.expires_at:
                continue
            if entry.rule_id != "*" and entry.rule_id != finding.rule_id:
                continue
            if entry.fingerprint != "*" and entry.fingerprint.lower() != finding.fingerprint.lower():
                continue
            pattern = entry.path.replace("\\", "/")
            if pattern.startswith("./"):
                pattern = pattern[2:]
            if fnmatch.fnmatchcase(location, pattern) or fnmatch.fnmatchcase(
                Path(location).name, pattern
            ):
                return entry
        return None


class SecretScanner:
    def __init__(
        self,
        policy: ExceptionPolicy,
        rules: Sequence[SecretRule] = RULES,
    ) -> None:
        self.policy = policy
        self.rules = tuple(rules)
        self.findings: List[Finding] = []

    def scan_text(self, text: str, location: str, base_line: int = 1) -> List[Finding]:
        found: List[Finding] = []
        seen: Set[Tuple[str, int, str]] = set()
        for line_number, line in enumerate(text.splitlines(), start=base_line):
            for rule in self.rules:
                for match in rule.pattern.finditer(line):
                    value = match.group(rule.value_group) if rule.value_group else match.group(0)
                    if not value or is_placeholder(value):
                        continue
                    fingerprint = compute_fingerprint(value)
                    key = (rule.rule_id, line_number, fingerprint)
                    if key in seen:
                        continue
                    seen.add(key)
                    finding = Finding(
                        rule_id=rule.rule_id,
                        description=rule.description,
                        severity=rule.severity,
                        location=location,
                        line=line_number,
                        fingerprint=fingerprint,
                        length=len(value.strip()),
                    )
                    entry = self.policy.match(finding)
                    if entry is not None:
                        finding.exempted = True
                        finding.exception_id = entry.id
                        entry.used = True
                    found.append(finding)
        self.findings.extend(found)
        return found

    def scan_file(self, path: Path, location: Optional[str] = None) -> List[Finding]:
        if path.is_symlink() or not path.is_file():
            return []
        if path.suffix.lower() in IGNORED_EXTENSIONS:
            return []
        try:
            if path.stat().st_size > MAX_SCAN_FILE_BYTES:
                return []
            data = path.read_bytes()
        except OSError:
            return []
        return self.scan_text(
            data.decode("utf-8", errors="ignore"),
            location or self._relative_location(path, path.parent),
        )

    def scan_directory(self, root: Path) -> List[Finding]:
        root = Path(root)
        if not root.is_dir():
            return []
        found: List[Finding] = []
        for current, dirs, files in os.walk(root, followlinks=False):
            dirs[:] = sorted(d for d in dirs if d not in IGNORED_DIRECTORIES)
            for name in sorted(files):
                path = Path(current) / name
                found.extend(self.scan_file(path, self._relative_location(path, root)))
        return found

    def scan_git_diff(self, diff_text: str) -> List[Finding]:
        found: List[Finding] = []
        current_file: Optional[str] = None
        new_line = 0
        for raw_line in diff_text.splitlines():
            if raw_line.startswith("diff --git "):
                parts = raw_line.split(maxsplit=3)
                target = parts[3] if len(parts) > 3 else ""
                current_file = target[2:] if target.startswith("b/") else target or None
                new_line = 0
            elif raw_line.startswith("+++ "):
                target = raw_line[4:]
                if target != "/dev/null":
                    current_file = target[2:] if target.startswith("b/") else target
            elif raw_line.startswith("@@"):
                header = re.search(r"\+(\d+)(?:,(\d+))?", raw_line)
                new_line = int(header.group(1)) - 1 if header else 0
            elif raw_line.startswith("+") and not raw_line.startswith("+++"):
                new_line += 1
                if current_file is None:
                    continue
                if Path(current_file).suffix.lower() in IGNORED_EXTENSIONS:
                    continue
                found.extend(self.scan_text(raw_line[1:], current_file, new_line))
            elif raw_line.startswith("-"):
                continue
            else:
                new_line += 1
        return found

    def scan_commits(self, revision_range: str) -> List[Finding]:
        try:
            result = subprocess.run(
                ["git", "diff", "-U0", "--no-ext-diff", revision_range],
                capture_output=True,
                text=True,
                check=True,
            )
        except subprocess.CalledProcessError as exc:
            raise ScanError(
                f"git diff failed for commit range '{revision_range}' (exit {exc.returncode})."
            ) from None
        return self.scan_git_diff(result.stdout)

    def scan_staged(self) -> List[Finding]:
        try:
            result = subprocess.run(
                ["git", "diff", "--cached", "-U0", "--no-ext-diff"],
                capture_output=True,
                text=True,
                check=True,
            )
        except subprocess.CalledProcessError as exc:
            raise ScanError(f"git diff --cached failed (exit {exc.returncode}).") from None
        return self.scan_git_diff(result.stdout)

    def scan_artifacts(self, target: Path) -> List[Finding]:
        target = Path(target)
        if target.is_file():
            return self._scan_artifact_file(target)
        if not target.is_dir():
            return []
        found: List[Finding] = []
        for current, dirs, files in os.walk(target, followlinks=False):
            dirs[:] = sorted(d for d in dirs if d not in IGNORED_DIRECTORIES)
            for name in sorted(files):
                path = Path(current) / name
                if path.is_symlink():
                    continue
                found.extend(self._scan_artifact_file(path))
        return found

    def check_env_examples(self, root: Path) -> List[Finding]:
        root = Path(root)
        pattern = re.compile(r"^\.env\.(?:example|sample|template)$")
        found: List[Finding] = []
        if not root.is_dir():
            return found
        for current, dirs, files in os.walk(root, followlinks=False):
            dirs[:] = sorted(d for d in dirs if d not in IGNORED_DIRECTORIES)
            for name in sorted(files):
                if pattern.match(name):
                    path = Path(current) / name
                    found.extend(self.scan_file(path, self._relative_location(path, root)))
        return found

    def _scan_artifact_file(self, path: Path) -> List[Finding]:
        name = path.name.lower()
        if name.endswith(".zip"):
            return self._scan_zip(path)
        if name.endswith((".tar.gz", ".tgz", ".tar")):
            return self._scan_tar(path)
        return self.scan_file(path, self._relative_location(path, path.parent))

    def _scan_zip(self, path: Path) -> List[Finding]:
        found: List[Finding] = []
        try:
            with zipfile.ZipFile(path) as archive:
                members = archive.infolist()
                if len(members) > MAX_ARCHIVE_MEMBERS:
                    return found
                for member in members:
                    if member.is_dir() or not self._safe_member_name(member.filename):
                        continue
                    if member.file_size > MAX_ARCHIVE_MEMBER_BYTES:
                        continue
                    mode = (member.external_attr >> 16) & 0o170000
                    if stat.S_ISLNK(mode):
                        continue
                    try:
                        with archive.open(member) as handle:
                            data = handle.read(MAX_ARCHIVE_MEMBER_BYTES + 1)
                    except (RuntimeError, OSError, zipfile.BadZipFile):
                        continue
                    if len(data) > MAX_ARCHIVE_MEMBER_BYTES:
                        continue
                    found.extend(
                        self.scan_text(
                            data.decode("utf-8", errors="ignore"),
                            f"{path}!{member.filename}",
                        )
                    )
        except (zipfile.BadZipFile, OSError):
            return found
        return found

    def _scan_tar(self, path: Path) -> List[Finding]:
        found: List[Finding] = []
        try:
            with tarfile.open(path, "r:*") as archive:
                members = archive.getmembers()
                if len(members) > MAX_ARCHIVE_MEMBERS:
                    return found
                for member in members:
                    if not member.isfile() or not self._safe_member_name(member.name):
                        continue
                    if member.size > MAX_ARCHIVE_MEMBER_BYTES:
                        continue
                    handle = archive.extractfile(member)
                    if handle is None:
                        continue
                    try:
                        data = handle.read(MAX_ARCHIVE_MEMBER_BYTES + 1)
                    except (OSError, tarfile.TarError):
                        continue
                    if len(data) > MAX_ARCHIVE_MEMBER_BYTES:
                        continue
                    found.extend(
                        self.scan_text(
                            data.decode("utf-8", errors="ignore"),
                            f"{path}!{member.name}",
                        )
                    )
        except (tarfile.TarError, OSError):
            return found
        return found

    @staticmethod
    def _safe_member_name(name: str) -> bool:
        normalized = name.replace("\\", "/")
        if not normalized or normalized.startswith("/") or re.match(r"^[A-Za-z]:", normalized):
            return False
        return ".." not in normalized.split("/")

    @staticmethod
    def _relative_location(path: Path, root: Path) -> str:
        try:
            return path.relative_to(root).as_posix()
        except ValueError:
            return path.as_posix()


def print_response_runbook(stream: Any) -> None:
    print(
        "\nSecret leak response steps:\n"
        "  1. Contain: treat the credential as compromised and revoke it at the provider.\n"
        "  2. Rotate: issue a least-privilege replacement and update secret storage.\n"
        "  3. Verify: confirm the old credential is inactive and review provider logs.\n"
        "  4. Document: record the incident and exposure window in the security tracker.\n"
        "  5. False positives: add only fingerprint-based, owner-approved, expiring exceptions.\n"
        "Never place detected values in issues, commits, artifacts, or exception files.\n",
        file=stream,
    )


def report_results(
    scanner: SecretScanner,
    policy: ExceptionPolicy,
    json_output: bool = False,
    output: Any = None,
    errors: Any = None,
) -> int:
    output = output or sys.stdout
    errors = errors or sys.stderr
    active = [finding for finding in scanner.findings if not finding.exempted]
    exempted = [finding for finding in scanner.findings if finding.exempted]
    failed = bool(policy.errors or policy.expired or active)

    if json_output:
        report: Dict[str, Any] = {
            "passed": not failed,
            "policyErrors": policy.errors,
            "expiredExceptions": policy.expired,
            "activeFindingsCount": len(active),
            "exemptedFindingsCount": len(exempted),
            "findings": [
                {
                    "ruleId": finding.rule_id,
                    "description": finding.description,
                    "severity": finding.severity,
                    "file": finding.location,
                    "line": finding.line,
                    "fingerprint": finding.fingerprint,
                    "redactedLength": finding.length,
                    "exempted": finding.exempted,
                    "exceptionId": finding.exception_id,
                }
                for finding in scanner.findings
            ],
        }
        print(json.dumps(report, indent=2, sort_keys=True), file=output)
        return 1 if failed else 0

    print("[SECRET SCAN]", file=output)
    if policy.errors:
        print("[FAIL] Policy validation errors:", file=errors)
        for error in policy.errors:
            print(f"  - {error}", file=errors)
    if policy.expired:
        print("[FAIL] Expired exceptions:", file=errors)
        for entry in policy.expired:
            print(
                f"  - {entry['id']} (owner {entry['owner']}) expired {entry['expiresAt']}.",
                file=errors,
            )
    if exempted:
        print(f"[INFO] {len(exempted)} finding(s) exempted by active policy:", file=output)
        for finding in exempted:
            print(
                f"  - {finding.exception_id}: {finding.rule_id} at "
                f"{finding.location}:{finding.line} fingerprint={finding.fingerprint}",
                file=output,
            )
    if active:
        print(f"[FAIL] {len(active)} active secret detection(s):", file=errors)
        for finding in active:
            print(
                f"  - [{finding.severity}] {finding.rule_id}: {finding.description}\n"
                f"    Location: {finding.location}:{finding.line}\n"
                f"    Fingerprint: {finding.fingerprint}\n"
                f"    Redacted length: {finding.length}",
                file=errors,
            )
        print_response_runbook(errors)
    if not failed:
        print("[PASS] Secret scan completed with no unapproved secrets.", file=output)
    return 1 if failed else 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Scan commits, files, and release artifacts for secrets without disclosing values."
    )
    parser.add_argument("--path", type=Path, default=None, help="Directory to scan recursively.")
    parser.add_argument(
        "--commits",
        nargs="?",
        const="HEAD~1..HEAD",
        default=None,
        help="Scan added lines in a git commit range.",
    )
    parser.add_argument("--staged", action="store_true", help="Scan staged changes.")
    parser.add_argument(
        "--artifacts", type=Path, default=None, help="File or directory of release artifacts."
    )
    parser.add_argument(
        "--exceptions",
        type=Path,
        default=Path(".github/secret-scan-exceptions.json"),
        help="Exception policy JSON path.",
    )
    parser.add_argument(
        "--check-env",
        action="store_true",
        help="Scan committed .env.example/.env.sample/.env.template files.",
    )
    parser.add_argument("--current-date", default=None, help="Override today (YYYY-MM-DD).")
    parser.add_argument("--json", action="store_true", help="Emit a machine-readable report.")
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    current_date = dt.date.today()
    if args.current_date is not None:
        if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", args.current_date):
            print("[ERROR] --current-date must use YYYY-MM-DD format.", file=sys.stderr)
            return 2
        try:
            current_date = dt.date.fromisoformat(args.current_date)
        except ValueError:
            print("[ERROR] --current-date is not a valid calendar date.", file=sys.stderr)
            return 2

    policy = ExceptionPolicy(args.exceptions, current_date=current_date)
    scanner = SecretScanner(policy)
    selected = any((args.path, args.commits, args.staged, args.artifacts, args.check_env))
    try:
        if args.staged:
            scanner.scan_staged()
        if args.commits is not None:
            scanner.scan_commits(args.commits)
        if args.artifacts is not None:
            scanner.scan_artifacts(args.artifacts)
        if args.check_env:
            scanner.check_env_examples(Path.cwd())
        if args.path is not None:
            scanner.scan_directory(args.path)
        if not selected:
            scanner.scan_directory(Path.cwd())
            scanner.check_env_examples(Path.cwd())
    except ScanError as exc:
        print(f"[ERROR] {exc}", file=sys.stderr)
        return 2
    return report_results(scanner, policy, json_output=args.json)


if __name__ == "__main__":
    sys.exit(main())
