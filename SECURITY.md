# Security Policy

## Supported Versions

Currently, only the latest version of the Stellar-Dex-Chat project is supported with security updates.

## Reporting a Vulnerability

### Private Vulnerability Reporting

We use GitHub's private vulnerability reporting feature to securely report security vulnerabilities.

**To report a security vulnerability:**

1. Visit the [Security Advisories](https://github.com/leojay-net/Stellar-Dex-Chat/security/advisories) page
2. Click "Report a vulnerability"
3. Fill in the details of the vulnerability
4. Submit the report privately

This ensures that the report is only visible to the repository maintainers until a fix is released.

### What to Include

Please include as much of the following information as possible:

- A description of the vulnerability
- Steps to reproduce the vulnerability
- Proof of concept (if applicable)
- Potential impact of the vulnerability
- Any suggested mitigations or fixes

### Scope

This security policy applies to:
- The Stellar-Dex-Chat smart contracts (Dechat/stellar-contracts)
- The frontend application (Dechat/dex_with_fiat_frontend)
- Any backend services or APIs

### Response Targets

- **Initial response**: Within 48 hours of receiving a report
- **Triaging**: Within 7 days of receiving a report
- **Fix timeline**: Depending on severity, typically within 30 days

## Dependency Vulnerability Scanning

Dependencies are scanned for known advisories using ecosystem advisory data:

- **Cargo** (Rust) via `cargo-audit` against the RustSec Advisory Database.
- **pnpm** (Node) via `pnpm audit` against the GitHub Advisory Database.

Scans run on every pull request and on a recurring schedule (weekly), so new advisories are caught even without code changes.

### Severity Thresholds

| Severity | Policy |
| --- | --- |
| Critical | Block merge; remediate immediately |
| High | Block merge; remediate within 7 days |
| Moderate | Remediate within 30 days |
| Low | Track; remediate at next dependency refresh |

### Time-Bounded Exceptions

A finding may be temporarily accepted only through a documented exception that records:

- **Owner**: the individual accountable for remediation
- **Expiry**: a fixed date by which the exception must be resolved or renewed
- **Justification**: why the finding cannot be fixed now

Exceptions are reviewed at expiry; expired exceptions fail the scan and block merge.

### Reporting Findings

Each finding must report the full transitive dependency path (the chain of packages that pulls in the vulnerable crate/package) and the patched version that resolves the advisory, so reviewers can assess impact and upgrade targets.

### Remediation Policy

Security upgrades follow the normal review and test gates. Dependency bumps are **not** auto-merged; they go through the same pull request review and CI checks as any other change.

### Security Best Practices

- Never include private keys or sensitive data in code
- Use environment variables for configuration
- Keep dependencies up to date
- Follow the principle of least privilege
- Audit smart contracts before deployment

## Secret Scanning & Leak Response

Secret detection runs on pull requests, weekly security audits, and published
releases. It covers the committed tree, environment example files, added lines
in PR commits, and release assets such as SBOMs, provenance records, and
archives.

Scan output contains rule ids, locations, SHA-256 fingerprints, and redacted
value lengths only. Detected values are discarded after fingerprinting and are
never printed to stdout, stderr, JSON reports, or CI logs.

False positives require an owner-approved, expiring exception in
`.github/secret-scan-exceptions.json`. Exceptions store fingerprints, an
approver from `allowedOwners`, approval and expiry dates, and a justification;
they never store plaintext values. Exceptions expire after at most 90 days by
default, and expired exceptions fail the scan. Changes to the exception policy
require CODEOWNERS review.

If a genuine credential is found:

1. **Contain** — revoke it at the provider immediately; do not rely on history
   rewriting.
2. **Rotate** — issue a least-privilege replacement and update secret storage.
3. **Verify** — confirm the old credential is inactive and review provider logs
   for the exposure window.
4. **Document** — record the incident without pasting the value into issues or
   PRs.
5. **Recover** — only verified false positives may be added as fingerprint-based
   exceptions with an expiry date.

Full CLI usage, exception rules, and incident procedures are in
[`docs/operations/secret-scanning.md`](docs/operations/secret-scanning.md).

### Acknowledgments

We appreciate responsible disclosure and will acknowledge security researchers who help improve the security of this project (with their permission).
