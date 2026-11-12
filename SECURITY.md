# Security policy

## Supported versions

| Version | Supported |
|---|---|
| 1.2.x | ✅ |
| < 1.2 | ❌ (please update) |

## Reporting a vulnerability

Please **do not open a public issue** for security problems.
Report them privately through [GitHub Security Advisories](https://github.com/sami-hussain-dev/PHP-Station/security/advisories/new) or via [x8code.com](https://x8code.com).

Please include:
- the affected version;
- steps to reproduce;
- what an attacker could do with it.

You will get an answer as soon as possible, and credit in the changelog if you want it.

## Security model (summary)

- The HTTP panel binds to `127.0.0.1` only. It rejects foreign `Host` / `Origin` headers and needs a random token, generated on every start, for every API call. Every page is sent with a strict Content-Security-Policy (no external scripts, styles or connections).
- Only processes that PHP Station has started or verified itself are stopped (matched by PID, executable and port).
- DB passwords are never written to disk or to logs. They reach MySQL/MariaDB tools only through the `MYSQL_PWD` environment variable of the child process.
- Downloads come only from fixed official hosts and are verified with SHA-256 before they are unpacked.
- phpMyAdmin is served on `127.0.0.1` only and uses cookie authentication; its secret is stored in the local data folder.
