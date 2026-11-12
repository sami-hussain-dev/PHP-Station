# Contributing to PHP Station

Thank you for helping. Bug reports, ideas, translations and pull requests are all welcome.

## Ground rules

- **Zero dependencies.** PHP Station uses only Node.js built-ins. Please do not add npm packages, CDNs or build steps.
- **Never risk user data.** Nothing may overwrite or delete a user's database, data folder, project file or `.env` without an explicit, confirmed action and a backup first.
- **Local only.** The panel must keep listening on `127.0.0.1`, checking `Host` / `Origin`, and requiring the per-start token.
- **Official sources only.** Downloads come from the official project sites and are checked against their published SHA-256.
- **Three languages.** Every new UI text needs an English, a Roman Urdu and an Urdu (Urdu script) version. Front-end texts live in `public/i18n.js`; server messages live in `lib/i18n.js`.

## Development

```bash
git clone https://github.com/sami-hussain-dev/PHP-Station.git
cd php-station
node server.js --serve --port 7171 --data ./data-dev   # separate data folder for development
npm test                                               # node --test, no install needed
```

- `DEVPANEL_DB_TESTS=1 npm test` also runs the DB integration tests. They create temporary MariaDB servers on ports 3391/3392. Set `PHPSTATION_TEST_XAMPP` to a XAMPP folder that contains `mysql\bin`.
- `DEVPANEL_NET_TESTS=1 npm test` checks the live download sources (index files and HEAD requests only).

## Pull requests

1. Keep a PR focused on one change, and describe *why* it is needed.
2. Add or update tests in `tests/` for logic changes.
3. Run `npm test` on Windows before you open the PR.
4. For UI changes, attach a screenshot. Please do not show personal paths, project names or ports in it.

## Reporting bugs

Use the [bug report form](https://github.com/sami-hussain-dev/PHP-Station/issues/new/choose). The most useful attachments are:
- `data\logs\panel.log`
- the job log shown in the panel
- for DB problems, the server's error log (**DB Servers → Log**)

Remove anything private before you post.
