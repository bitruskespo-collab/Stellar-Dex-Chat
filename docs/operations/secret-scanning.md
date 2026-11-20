# Release-Time Secret Scanning

This repository runs a zero-disclosure secret scan on pull requests, scheduled
audits, and published releases. The scanner is implemented in
`tools/secret_scanner.py` and uses only the Python standard library.

## What is scanned

| Trigger | Scope |
| --- | --- |
| Pull request | Full committed tree, `.env.example`/`.env.sample`/`.env.template` files, and added lines in the PR commit range |
| Weekly schedule / manual dispatch | Full committed tree and environment example files |
| Published release | Published release assets, including CycloneDX SBOMs, provenance files, and archives |

The scanner recognizes Stellar seeds, PEM private keys, GitHub tokens, AWS
credentials, payment-provider secrets, Google API keys, Slack tokens, and
high-entropy credential assignments. Binary files, lockfiles, and ignored build
directories are skipped. Archive members are read in memory with path-traversal
and symlink entries rejected; nothing is extracted to disk.

## Output policy

Findings contain only:

- rule id, severity, and description
- repository-relative location and line number
- a `sha256:<digest>` fingerprint
- the redacted value length

Detected values, source lines containing them, and partial prefixes or suffixes
are never printed to stdout, stderr, JSON reports, or log files. Plaintext
values are discarded after fingerprinting.

## Exception policy

False positives are handled through `.github/secret-scan-exceptions.json`, whose
schema is `.github/secret-scan-exceptions.schema.json`. Both files are owned by
`@leojay-net` in `CODEOWNERS`, so changes require maintainer review.

An exception must contain:

- `id`: unique identifier
- `ruleId`: scanner rule id, or `*` with a narrow path
- `path`: repository-relative path or glob, without absolute paths or `..`
- `fingerprint`: `sha256:<digest>` from the scan report, or `*` only for a
  directory of known synthetic fixtures
- `owner`: a handle listed in `allowedOwners`
- `approvedAt`: approval date in `YYYY-MM-DD` format
- `expiresAt`: expiry date in `YYYY-MM-DD` format
- `justification`: at least 15 characters explaining why the match is safe

Rules enforced by the scanner:

- `approvedAt` cannot be in the future.
- `expiresAt` must be after `approvedAt`.
- `expiresAt - approvedAt` cannot exceed `maxExpiryDays` (90 days by default,
  maximum 365).
- Expired or unauthorized exceptions fail the scan even when they would not
  match the current findings.
- Fields that could hold plaintext values (`secret`, `secretValue`,
  `plaintext`, `rawValue`, token/password value fields) are rejected.
- Duplicate exception ids and malformed dates are rejected.

Renew an exception before its expiry by updating `expiresAt` in a reviewed PR.
Remove exceptions that are no longer needed.

## Local use

```sh
make secret-scan-test
make secret-scan
make secret-scan-staged
python3 tools/secret_scanner.py --commits origin/main..HEAD --json
python3 tools/secret_scanner.py --artifacts release-artifacts --json
```

`--json` is safe to attach to CI logs because it contains no detected values.
`--current-date YYYY-MM-DD` makes expiry checks deterministic in tests.

## Leak response

If a scan reports a genuine credential:

1. **Contain** — treat the credential as compromised and revoke it at the
   provider or secret store immediately. Do not rely on rewriting history.
2. **Rotate** — issue a least-privilege replacement and update the repository
   or deployment secret store.
3. **Verify** — confirm the old credential is inactive and review provider logs
   for use during the exposure window.
4. **Document** — record the incident, exposure window, and remediation in the
   security tracker. Never paste the value into an issue or PR.
5. **Recover** — if the match was a verified false positive, add an
   owner-approved, fingerprint-based exception with an expiry date.

See `SECURITY.md` for the security-policy summary and reporting contacts.
