<div align="center">

<img src="docs/assets/logo.svg" width="96" height="96" alt="PHP Station logo">

# PHP Station

**Run every PHP & Laravel project side by side on Windows, each with its own PHP version, Composer and MariaDB server.**

A free, open-source, zero-dependency local development environment and control panel.
It works as a modern **XAMPP / Laragon alternative** and also uses the XAMPP / Laragon you already have.

[![License: MIT](https://img.shields.io/badge/license-MIT-2ea44f.svg)](LICENSE)
[![Platform: Windows 10/11](https://img.shields.io/badge/platform-Windows%2010%20%7C%2011-0078D6.svg?logo=windows)](#requirements)
[![Node.js 18+](https://img.shields.io/badge/node-%E2%89%A518-339933.svg?logo=node.js&logoColor=white)](#requirements)
[![Zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](package.json)
[![PHP 7.4 – 8.5](https://img.shields.io/badge/PHP-7.4%20%E2%80%93%208.5-777BB4.svg?logo=php&logoColor=white)](#features)
[![MariaDB](https://img.shields.io/badge/MariaDB-10.4%20%E2%80%93%2012.x-003545.svg?logo=mariadb&logoColor=white)](#features)
[![Tests](https://github.com/sami-hussain-dev/PHP-Station/actions/workflows/tests.yml/badge.svg)](https://github.com/sami-hussain-dev/PHP-Station/actions/workflows/tests.yml)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-ff69b4.svg)](CONTRIBUTING.md)

[Features](#features) · [Screenshots](#screenshots) · [Quick start](#quick-start) · [Compared with XAMPP / Laragon](#php-station-vs-xampp-vs-laragon) · [FAQ](#faq) · [Roman Urdu](#roman-urdu)

<img src="docs/screenshots/01-projects.png" alt="PHP Station dashboard: five PHP and Laravel projects, each with its own PHP version, Composer and MariaDB server, three of them running" width="100%">

</div>

---

## What is PHP Station?

PHP Station is a **local PHP development environment for Windows**. It runs on your own computer only (`127.0.0.1`).
From one dark/silver control panel you can:

- run **many PHP projects at the same time**, each on its own port;
- give each project **its own PHP version** (for example Laravel 8 on PHP 8.0 next to Laravel 12 on PHP 8.3), its own **Composer** and its own **MariaDB / MySQL server**;
- install PHP, MariaDB, Composer and phpMyAdmin from their **official sources**. Every download is checked with SHA-256, needs no admin rights and does not change the PATH;
- keep your databases **safe from the classic XAMPP crash**. DB servers are stopped cleanly on Windows shutdown, the data folder is snapshotted before every start, a `.sql` dump is taken every day, and a crashed server can be repaired with one click.

It is plain **Node.js with zero npm dependencies**. Nothing needs to be built or installed: double-click `PHP-Station.bat` and it opens.
The interface is available in **English, Roman Urdu and Urdu (RTL)**.

## Features

### New in 1.3
- **Shift from XAMPP / Laragon in one click.** PHP Station finds every project of your XAMPP, Laragon or WAMP: `htdocs` / `www` folders and Apache / nginx virtual hosts such as `shop.test`. Each project keeps the **same PHP and DB server it used before**. Nothing is copied or moved, and the databases stay in their old data folder.
- **DB Time Machine.** A restore point of the project's database is saved **automatically before `php artisan migrate`, `migrate:fresh`, `db:seed`, `db:wipe` …** in the project terminal, or by hand. One click puts the database back. Before that, the current state is saved too, so an undo can itself be undone. The restore point is test-imported into a scratch database first, so the real database is never touched if anything is wrong.
- **Live share link.** One button gives a running project a public `https://….trycloudflare.com` link, through a Cloudflare quick tunnel: no account, no hosting, no router settings. Send it to a client's phone. Laravel sees HTTPS correctly, and the link ends when you stop it, stop the project or close the panel.
- **Fast server.** On Windows, `php -S` answers only one request at a time, so a page's CSS, JS and images waited behind it. PHP Station now serves static files itself and spreads PHP requests over 4 PHP workers per project (configurable in Settings). In our test, static files went from 2.4 s to under 10 ms while a page was loading. Your app runs unchanged.
- **`phpstation.json` for teams.** Commit one small file, and every teammate gets the whole setup in one click: the right PHP and MariaDB versions (installed from official sources), extensions, DB server, `.env`, `composer install`, `APP_KEY`, the database, `migrate` and `storage:link`.

```json
{
  "$schema": "https://sami-hussain-dev.github.io/PHP-Station/phpstation.schema.json",
  "name": "Shop",
  "php": "8.3",
  "extensions": ["intl", "gd"],
  "database": { "engine": "mariadb", "version": "11.4", "name": "shop_db" },
  "setup": ["env", "composer-install", "key", "database", "migrate", "storage-link"]
}
```

#### DB Time Machine: what it does

![DB Time Machine, Every action: each INSERT / UPDATE / DELETE with its SQL and old / new values, and an Undo button for that one action](docs/screenshots/13-db-time-machine.png)

**Every action.** Every INSERT, UPDATE and DELETE in the project's database is recorded: from the app, from phpMyAdmin, or from plain SQL. Each one is listed with its time, its SQL, and the old and new values with column names. **Undo this** reverses only that one action. A deleted row comes back, an update gets its old values again, and everything else stays as it is. The undo is itself recorded, so it can be undone too. If the same rows were changed again later, PHP Station warns you first.

**Busy days stay readable.** Actions are grouped by hour, and a run of the same kind of action on one table becomes one line (`orders · INSERT × 250`) that opens on click. The counts at the top double as filters (All / DELETE / UPDATE / INSERT / TABLE), and you can search by `id=21` or by any value. The newest 100 come first, and older ones load on request.

![DB Time Machine on a busy day: actions grouped by hour, repeated actions folded into one line, counts as filters](docs/screenshots/15-db-busy-day.png)

How it works: MariaDB's own row-based binary log, switched on when PHP Station starts the server (MariaDB 10.2+). No `my.ini` is changed; the log lives in PHP Station's backup folder and expires after 7 days (configurable). A single action is reversed with `mariadb-binlog --flashback`. Table changes (CREATE / ALTER / DROP) are listed but are undone with a restore point.

![DB Time Machine, Restore points: full copies of the database, one click back to any of them](docs/screenshots/14-db-restore-points.png)

**Restore points (the whole database):**

1. **It takes a "photo" of the database (a restore point).** It also takes a baseline the moment a project is added. This happens by itself right before `php artisan migrate`, `migrate:fresh`, `migrate:rollback`, `db:seed` or `db:wipe` runs in a PHP Station terminal, or whenever you press **Save a restore point now**.
2. **If something goes wrong** (data wiped, a table dropped, a broken migration), press **Time Machine** on the project card, pick a moment and press **Go back here**.
3. **The database becomes exactly as it was at that moment.** The current state is saved first, so the undo itself can be undone. The restore point is test-imported into a scratch database before the real one is touched.

Restore points are `.sql` files in `devpanel-backups\points\<project>\`. The last 20 automatic points per project are kept (configurable in Settings); manual ones are never removed.

### Projects
- **Add or scan folders.** PHP Station reads `composer.json`, `composer.lock`, `vendor` and `.env`, detects the Laravel version, and **suggests the right PHP** (★). A warning appears when the chosen PHP does not match the project.
- **One toggle to run or stop a project.** Each project runs on its own port; the port is asked once before the first run and then remembered.
- **Many PHP versions at once.** XAMPP, Laragon, WAMP and PATH installs are found automatically. Copied PHP folders get a relocated `php.ini` copy.
- **A terminal per project.** In it, `php` and `composer` are exactly the versions chosen for that project (`composer install`, `migrate:status`, `optimize:clear`, `tinker` …).
- **Setup checklist.** It creates `.env` from `.env.example`, writes the DB settings and `APP_URL`, runs `composer install` and `php artisan key:generate`. Every `.env` change is backed up first.
- **Missing database on Run.** You can copy it from another server, import a `.sql` file or create it empty. Nothing is ever overwritten.
- **Right DB port without editing `.env`.** If `.env` names a different `DB_PORT`, PHP Station passes the correct port through the environment.
- **External servers.** `php artisan serve` and `php -S` servers you started yourself are shown, and you can adopt or stop them.
- **"Show paths" per project.** Shows the PHP, `php.ini`, Composer, DB server, datadir and project folder, each with a copy button.

### Databases
- **DB servers.** Start and stop (gracefully) any MariaDB / MySQL install, see its logs and databases, and create **new isolated server instances** on their own port.
- **Laragon / XAMPP aware.** If the same data folder is already being served (even by an elevated Laragon), that server is used instead of starting a second one.
- **phpMyAdmin built in.** PHP Station runs its own copy, with every DB server listed on its own port, and can open it straight into a project's database. It is installed from phpmyadmin.net or copied from XAMPP / Laragon.
- **DB Move.** Moves a database from an old server to a new one (dump, import, then row counts compared table by table).

### Crash-safe by design
- **Shutdown guard.** A tiny helper (`PHPStationGuard.exe`) makes Windows wait on shutdown, restart or sign-out, and sends every DB server its clean-shutdown signal. This prevents the most common cause of *"MySQL shutdown unexpectedly"* in XAMPP.
- **Automatic snapshots.** A full copy of a stopped server's data folder is taken before PHP Station starts it (daily or always, kept as the last *N* copies, with a size limit).
- **Daily dumps.** A `.sql` file of every database of each running server is made once a day.
- **One-click repair.** It reads the error log (crashed Aria/MyISAM tables, broken privilege tables, Aria log, *"log sequence number is in the future"*, tables missing in the engine, port or lock problems), takes a snapshot, and then repairs: `aria_chk` / `myisamchk`, system tables rebuilt from a clean template, then `mariadb-check --auto-repair`.
- **Rescue data.** For InnoDB damage it works on a copy, never on the original data. It tries `innodb_force_recovery` 1 → 6, dumps everything, and can import the result into a fresh server.
- **Old data is never deleted or overwritten.** Restores keep the current folder as `…_before_restore_<time>`, and dumps are restored only into a **new** database.

### Setup wizard and installer
- **Setup wizard.** Shows what is already on the computer, works out what your projects need, and suggests what to install (**Auto select**). It then installs everything in one batch.
- **Official sources only.** windows.php.net (PHP 7.4 – 8.5), mariadb.org (including LTS and end-of-life 10.4 / 10.5), getcomposer.org and phpmyadmin.net. Every file is checked with SHA-256. Everything goes into PHP Station's own `runtimes` folder.
- **Shortcuts.** On the first start, a **Desktop and Start Menu shortcut** is created automatically.

### Safety of the panel itself
- It listens on `127.0.0.1` only, checks `Host` / `Origin`, needs a per-start token for every API call, and sends a strict Content-Security-Policy.
- It only stops processes it has verified itself. Other programs are never touched.
- DB passwords are never stored or logged; they reach MySQL / MariaDB tools only through `MYSQL_PWD`.

## Screenshots

| | |
|---|---|
| ![Projects: each PHP project with its own PHP version, Composer, DB server and port](docs/screenshots/01-projects.png) | ![Show paths: PHP, php.ini, Composer, DB server, datadir and project folder of one project](docs/screenshots/02-project-paths.png) |
| **Projects**: one card per project, each with its own PHP, Composer, DB server and port | **Show paths**: every path of a project, each with a copy button |
| ![DB Servers: two MariaDB servers running side by side on their own ports](docs/screenshots/03-db-servers.png) | ![phpMyAdmin opened by PHP Station on a project database](docs/screenshots/12-phpmyadmin.png) |
| **DB Servers**: MariaDB 12.3 and 10.4 running side by side | **phpMyAdmin**: built in, every server on its own port |
| ![Backups: data folder snapshots and daily SQL dumps](docs/screenshots/04-backups.png) | ![One-click repair of a MariaDB server from its error log](docs/screenshots/05-repair.png) |
| **Backups**: snapshots and daily `.sql` dumps | **Repair**: reads the error log, snapshot first, then fixes it |
| ![Setup wizard step 1: what is installed and what each project needs](docs/screenshots/07-setup-wizard.png) | ![Setup wizard step 2: choose PHP, MariaDB, Composer and phpMyAdmin versions](docs/screenshots/08-setup-wizard-pick.png) |
| **Setup wizard**: what you have and what your projects need | **Choose versions**: auto select, then install everything in one batch |
| ![Runtimes: PHP, Composer and MariaDB installs found on the computer](docs/screenshots/06-runtimes.png) | ![Safety settings: shutdown guard, automatic snapshots and daily dumps](docs/screenshots/09-safety-settings.png) |
| **Runtimes**: everything found on this computer | **Safety settings**: guard, snapshots, dumps |
| ![PHP Station in the light silver theme](docs/screenshots/10-projects-light.png) | ![PHP Station in Urdu, right-to-left](docs/screenshots/11-projects-urdu.png) |
| **Light theme** | **Urdu (RTL)**, plus English and Roman Urdu |
| ![DB Time Machine: every INSERT / UPDATE / DELETE with an Undo button](docs/screenshots/13-db-time-machine.png) | ![DB Time Machine: restore points of the whole database](docs/screenshots/14-db-restore-points.png) |
| **DB Time Machine, Every action**: undo one INSERT / UPDATE / DELETE | **DB Time Machine, Restore points**: the whole database, one click back |

## Quick start

1. **Download** this repository (green *Code* button → *Download ZIP*) or clone it:
   ```bash
   git clone https://github.com/sami-hussain-dev/PHP-Station.git
   ```
2. **Double-click `PHP-Station.bat`.** The panel opens as an app window at `http://127.0.0.1:7070/`. If port 7070 is busy, the next free port is used.
   A Desktop and Start Menu shortcut is created on the first start.
3. If no PHP / MariaDB is installed yet, the **Setup wizard** opens and installs what your projects need.
4. Click **+ New project** or **Scan folders**, check the suggested PHP, and switch the project on.

To stop only the panel, run `PHP-Station-Stop.bat` (or use *Settings*). Projects and DB servers keep running.

<details>
<summary><b>Command line</b></summary>

```bash
node server.js --launch            # start (if needed) and open the app window
node server.js --serve [--port N] [--data DIR] [--no-open]
node server.js --stop  [--data DIR]
npm test                           # zero-dependency test suite (node --test)
```

| Environment variable | Meaning |
|---|---|
| `DEVPANEL_DATA` | data folder (default `<install>\data`) |
| `DEVPANEL_NO_SHORTCUTS=1` | do not create the Desktop / Start Menu shortcuts automatically |
| `DEVPANEL_DB_TESTS=1` | also run the DB integration tests (temporary MariaDB servers on ports 3391/3392) |
| `PHPSTATION_TEST_XAMPP` | XAMPP folder used by the integration tests (default `C:\xampp`) |
| `DEVPANEL_NET_TESTS=1` | also check the live download sources (index files and HEAD requests only) |

</details>

## Requirements

- **Windows 10 or 11** (x64).
- **Node.js 18 or newer.** If it is missing, `PHP-Station.bat` offers to download the portable Node.js LTS from nodejs.org into `runtimes\node` (SHA-256 verified, no admin rights).
- **PHP / MariaDB / Composer.** Use the ones you already have (XAMPP, Laragon, WAMP …) or install them with the Setup wizard.

## PHP Station vs XAMPP vs Laragon

PHP Station does not replace your existing installs. It finds them and uses them, and it can also install its own.

| | PHP Station | XAMPP | Laragon |
|---|:---:|:---:|:---:|
| Different PHP version **per project, at the same time** | ✅ | ❌ one PHP per install | ⚠️ one global version, switched |
| Several MariaDB / MySQL servers side by side | ✅ | ❌ | ⚠️ manual |
| Suggests the right PHP from `composer.json` / Laravel | ✅ | ❌ | ❌ |
| Clean DB stop on Windows shutdown / sign-out | ✅ shutdown guard | ❌ | ❌ |
| Automatic data-folder snapshots + daily `.sql` dumps | ✅ | ❌ | ❌ |
| One-click DB repair from the error log | ✅ | ❌ | ❌ |
| Official downloads with SHA-256 check | ✅ | – | – |
| Uses existing XAMPP / Laragon installs | ✅ | – | – |
| One-click move of all projects from XAMPP / Laragon | ✅ | – | – |
| Undo a bad `migrate:fresh` (automatic DB restore points) | ✅ | ❌ | ❌ |
| Public HTTPS link for a client, no account | ✅ Cloudflare quick tunnel | ❌ | ⚠️ ngrok, manual |
| Team setup file (`phpstation.json`) | ✅ | ❌ | ❌ |
| Size of the tool itself | ~1 MB of code, zero dependencies | ~150 MB+ | ~100 MB+ |

<sub>Based on the default behaviour of XAMPP and Laragon at the time of writing. If something here is out of date, please open an issue.</sub>

## FAQ

<details open>
<summary><b>How do I run two Laravel projects with different PHP versions on Windows?</b></summary>

Add both projects to PHP Station and choose a PHP version on each card, for example PHP 8.0 for a Laravel 8 app and PHP 8.3 for a Laravel 12 app. Switch both on. Each project runs with its own `php.exe` on its own port, at the same time. Nothing is switched globally.
</details>

<details>
<summary><b>Is PHP Station a replacement for XAMPP or Laragon?</b></summary>

It can be. It installs PHP, MariaDB, Composer and phpMyAdmin by itself. It also works on top of an existing XAMPP or Laragon: their PHP versions and DB servers appear automatically and can be used per project.
</details>

<details>
<summary><b>How does PHP Station prevent "MySQL shutdown unexpectedly" in XAMPP?</b></summary>

That error usually comes from a DB server that was killed during Windows shutdown or sign-out, or from two servers using the same data folder. PHP Station's shutdown guard makes Windows wait and stops every DB server cleanly. It also refuses to start a second server on a data folder that is in use, and it takes a snapshot of the data folder before each start.
</details>

<details>
<summary><b>How do I repair a crashed MariaDB / MySQL database?</b></summary>

Open **DB Servers → Repair** on the server's card. PHP Station reads the error log and names the problem. Then, after a full snapshot, it repairs the crashed Aria / MyISAM tables, rebuilds broken system tables from a clean template and checks every table. For InnoDB damage, use **Rescue data**: it works on a copy of the data folder, never on the original.
</details>

<details>
<summary><b>I ran <code>php artisan migrate:fresh</code> by mistake. Can I get my data back?</b></summary>

Yes, if you ran it in a terminal opened from PHP Station. Before every `migrate*` / `db:*` command, a restore point of the project's database is saved automatically. Press **Time Machine** on the project card and choose **Go back here**. Restore points can also be made by hand at any time.
</details>

<details>
<summary><b>How do I show my local Laravel site to a client without hosting?</b></summary>

Start the project and press **Live link** on its card. You get an `https://….trycloudflare.com` address that opens on any phone or computer. It uses Cloudflare's free quick tunnels (no account needed). The link stops when you press *Stop live link*, stop the project or close PHP Station.
</details>

<details>
<summary><b>How do I move from XAMPP or Laragon to PHP Station?</b></summary>

Click **Shift from XAMPP / Laragon** on the Projects page. Every project found in `htdocs` / `www` and in the virtual hosts is listed with the PHP and DB server it already used. Choose the ones you want and press **Shift selected**. Your XAMPP / Laragon folder is not changed, so you can still open it whenever you like.
</details>

<details>
<summary><b>Does PHP Station need admin rights or change my PATH?</b></summary>

No. Everything it installs goes into its own `runtimes` folder, and the system PATH is never changed.
</details>

<details>
<summary><b>Is it safe? Can other computers open the panel?</b></summary>

No other computer can open it. The panel listens on `127.0.0.1` only, checks `Host` and `Origin`, and needs a random per-start token for every API call. DB passwords are never stored or logged.
</details>

<details>
<summary><b>Which PHP and MariaDB versions are supported?</b></summary>

PHP 7.4 – 8.5 (from windows.php.net) and MariaDB 10.4 – 12.x (from mariadb.org). Any PHP / MariaDB / MySQL already on the computer can be used too. MySQL itself is not downloaded, because Oracle's site blocks automated downloads and publishes no SHA-256 for the zip. MariaDB is a drop-in replacement for Laravel's `mysql` driver.
</details>

<details>
<summary><b>Where is my data?</b></summary>

- **Settings, project list, logs, `.env` backups:** `data\` inside the PHP Station folder.
- **Installed runtimes:** `runtimes\`.
- **DB backups:** `devpanel-backups\` inside the *DB dump folder* you choose in Settings.

None of these are committed to git.
</details>

## How it works

```text
PHP-Station.bat ──> node server.js --launch ──> local HTTP panel on 127.0.0.1:7070 (token + CSP)
                                                  │
           ┌──────────────────────┬───────────────┼──────────────────────┬────────────────────┐
           ▼                      ▼               ▼                      ▼                    ▼
   php -S per project      mysqld / mariadbd   phpMyAdmin (php -S)   PHPStationGuard.exe   installer
   (own php.exe + port)    (own datadir+port)  one entry per server  (clean DB shutdown)   (official + SHA-256)
```

The source is small and readable: `server.js` (HTTP + CLI), `lib/*.js` (projects, runtimes, DB servers, backups, repair, installer, wizard, phpMyAdmin, guard), and `public/` (a vanilla-JS single page; no framework, no build step).

## Roadmap

- Pretty local domains (`shop.test`) and local HTTPS
- Queue workers and a scheduler per project
- Local mail catcher
- Redis and Node.js services
- "New Laravel project" template

Have an idea? [Open an issue](https://github.com/sami-hussain-dev/PHP-Station/issues/new/choose).

## Contributing

Bug reports, ideas and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md). Security issues: see [SECURITY.md](SECURITY.md).

## Roman Urdu

**PHP Station** Windows ke liye aik local control panel hai jis se aap kai PHP / Laravel projects aik sath chala sakte hain. Har project apne PHP version, apne Composer aur apne MariaDB/MySQL server ke sath chalta hai.

- **Chalana:** `PHP-Station.bat` par double-click karein. Pehli dafa Desktop aur Start Menu me shortcut khud ban jata hai. Node.js na ho to PHP Station poochta hai aur portable Node khud `runtimes\node` me rakh deta hai.
- **Setup Wizard:** batata hai ke computer par kya hai aur projects ko kya chahiye, phir PHP, MariaDB, Composer aur phpMyAdmin official jagah se (SHA-256 check ke sath) install kar deta hai.
- **DB hifazat:** Windows band hote waqt DB servers saaf tareeqe se band hote hain. Server start hone se pehle data folder ki copy banti hai, aur roz `.sql` dump banta hai. Crash ho jaye to "Repair" ka aik button hai.
- **phpMyAdmin:** har DB server apne port ke sath aik jagah.
- **Kabhi overwrite nahi:** purana data kabhi delete ya overwrite nahi hota.

Tafseeli guide: [PEHLE-YE-PARHEIN.txt](PEHLE-YE-PARHEIN.txt).

## Credits & license

Built by **Sami Hussain**, founder of [x8code](https://x8code.com).
Released under the [MIT License](LICENSE).

<sub>Keywords: local PHP development environment for Windows, XAMPP alternative, Laragon alternative, WAMP alternative, multiple PHP versions on Windows, run Laravel projects side by side, PHP version manager for Windows, MariaDB manager, phpMyAdmin, MySQL crash repair, "MySQL shutdown unexpectedly" fix, automatic database backup, Composer per project, localhost control panel.</sub>
