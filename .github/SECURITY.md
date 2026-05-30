# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 9.x (latest) | ✅ Active |
| < 9.0 | ❌ End-of-life |

Always use the latest `argusqa-os` release from [npm](https://www.npmjs.com/package/argusqa-os).

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Report security issues by emailing **aryarasin@gmail.com** with:

- A description of the vulnerability
- Steps to reproduce (proof of concept if possible)
- Impact assessment (what an attacker could achieve)
- Affected version(s)

You will receive an acknowledgement within **48 hours** and a resolution timeline within **7 days**. Fixes are typically released within 14 days of confirmation.

Once a fix is released, a CVE will be requested if the vulnerability is significant. You will be credited in the release notes unless you request anonymity.

## Scope

**In scope:**
- Remote code execution via crafted target URLs or MCP tool inputs
- Credential or token leakage through logs, reports, or network traffic
- Path traversal in report output or fixture file handling
- Dependency vulnerabilities with a realistic exploit path against Argus users

**Out of scope:**
- Vulnerabilities in the target application Argus is auditing (Argus is the tester, not the testee)
- Issues requiring physical access to the machine running Argus
- Self-XSS in local HTML reports (reports are generated and consumed by the same user)
- Rate limiting or DoS against the local Chrome DevTools endpoint (port 9222 is localhost-only)
- Theoretical vulnerabilities with no realistic exploit path

## Security Design Notes

- Argus connects to Chrome only on `127.0.0.1:9222` — it never exposes a public endpoint
- Report files are written to `./reports/` with the file permissions of the running user
- Supabase credentials (landing page only) are stored in `landing/.env.local` which is gitignored
- The MCP server communicates over stdio — no network port is opened
