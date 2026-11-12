# Changelog

All notable changes to PHP Station are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

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

[1.2.0]: https://github.com/sami-hussain-dev/PHP-Station/releases/tag/v1.2.0
[1.1.0]: https://github.com/sami-hussain-dev/PHP-Station/releases/tag/v1.1.0
