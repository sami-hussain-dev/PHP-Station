# Changelog

All notable changes to PHP Station are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [1.3.0] - 2026-11-12

### Fixed
- Live link: an error line of cloudflared (`https://api.trycloudflare.com/tunnel`) was taken as the link. The link now counts only after the tunnel has connected, and there are up to 3 attempts when Cloudflare is slow to answer.

### Added
- **Shift from XAMPP / Laragon / WAMP.** Finds projects in `htdocs` / `www` and in Apache / nginx virtual hosts (Laragon `auto.*.test.conf`, XAMPP `httpd-vhosts.conf`). Each project keeps the PHP and DB server it used before. Read-only: nothing in the old stack is changed.
- **DB Time Machine.** Restore points of a project's database are made by hand, and automatically before `php artisan migrate*` / `db:*` in PHP Station terminals (php.bat shim → `tools\restore-point.js`; the command is never blocked). Undo first saves the current state, test-imports the point into a scratch database, and only then replaces the real database (it puts the old state back if the import fails). New settings: `pointBeforeArtisan`, `pointKeep`.
- **Live share link.** A Cloudflare quick tunnel (`cloudflared`, installed from the official GitHub release with a SHA-256 check) for a running project. An `auto_prepend_file` makes Laravel see HTTPS for tunnel requests only. Shares end with the project or the panel. A warning is shown when a Vite dev server is running.
- **DB Time Machine, Every action.** MariaDB servers that PHP Station starts keep a row-based binary log (in the backup folder, no my.ini change, settings `dbHistory` / `historyDays`). Time Machine lists every INSERT / UPDATE / DELETE of the project database with its SQL and old / new values, and undoes ONE action with `mariadb-binlog --flashback` (conflicting later changes are shown first). A baseline restore point is taken when a project is added.
- **Fast server.** On Windows `php -S` answers one request at a time, so every CSS / JS / image of a page waited behind the page itself (2.4 s in a test, now 2–7 ms). Projects now run behind a small Node server (`tools\fastserve.js`) that serves static files directly (never `.php` or dot-files) and spreads PHP requests over N `php -S` workers (setting `phpWorkers`, default 4; 1 = plain `php -S`).
- **`phpstation.json`.** Plan + one job: installs missing PHP / MariaDB / Composer, enables extensions (only in PHP Station's own PHP builds, `php.ini` backed up first), registers the project, starts its DB server, runs `.env` / `composer install` / `key:generate` / database / `migrate` / `db:seed` / `storage:link`. Export from any project card. JSON schema in `docs/phpstation.schema.json`.

## [1.2.0] - 2026-11-12

### Changed
- **New name: PHP Station** (formerly *DevPanel*). The launchers are now `PHP-Station.bat` and `PHP-Station-Stop.bat`. Existing data, settings, backups and environment variables (`DEVPANEL_*`) keep working unchanged.
- The shutdown guard is now `PHPStationGuard.exe`; a running guard from an older version is replaced automatically.
- The DB card footer no longer clips on narrow layouts ("Change port" is in the ⋯ menu).

### Added
- **Desktop and Start Menu shortcuts** are created automatically on the first start of an install, once per install folder. Old `DevPanel.lnk` shortcuts that point into the same folder are removed.
- **Setup wizard**: shows what is installed and what each project needs, selects versions automatically, and installs PHP, MariaDB, Composer and phpMyAdmin in one batch.
- **phpMyAdmin**: PHP Station runs its own copy (official download or copied from XAMPP/Laragon), lists every DB server on its own port, and opens a project's database directly.
- **Crash safety**: shutdown guard (clean DB stop on Windows shutdown/sign-out), automatic data-folder snapshots, daily `.sql` dumps, restore without overwriting, one-click repair from the error log, and InnoDB rescue on a copy.
- **Automatic DB start**: when a project runs, its DB server starts by itself. If a Laragon/XAMPP server already serves the same data folder (even as admin), that server is used.
- **`DB_PORT` override**: if `.env` names another port, the correct one is passed through the environment, and `.env` is not touched.
- **"Show paths"** per project (PHP, php.ini, Composer, DB server, datadir, project) with copy buttons.
- Links open in the system's default browser.
- Brand assets: logo, Windows icon, social preview; README screenshots; GitHub templates; `llms.txt`.

### Fixed
- phpMyAdmin no longer warns that `session.gc_maxlifetime` is lower than the cookie validity.
- A panel started with another data folder (a test run or a temporary panel) can no longer take over or stop the shutdown guard of the real install.

## [1.1.0]

- Projects with their own PHP, Composer and DB server; external `php -S` servers; DB servers and new instances; DB Move; missing-database flow; `.env` setup checklist; installer for PHP, MariaDB and Composer from official sources (SHA-256); English, Roman Urdu and Urdu UI.

[1.3.0]: https://github.com/sami-hussain-dev/PHP-Station/releases/tag/v1.3.0
[1.2.0]: https://github.com/sami-hussain-dev/PHP-Station/releases/tag/v1.2.0
[1.1.0]: https://github.com/sami-hussain-dev/PHP-Station/releases/tag/v1.1.0
