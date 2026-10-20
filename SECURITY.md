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

### Acknowledgments

We appreciate responsible disclosure and will acknowledge security researchers who help improve the security of this project (with their permission).
