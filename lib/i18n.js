'use strict';
/*
 * Backend texts in three languages: 'roman' (Roman Urdu, the default and the original texts),
 * 'en' (English) and 'ur' (Urdu script). tr(key, params) uses the current language, falls back
 * to roman and then to the key itself. Placeholders look like {name}.
 * Console output (CLI messages, terminal.cmd) uses consoleLang(): English for 'en', otherwise
 * Roman Urdu, because Windows consoles and .cmd files cannot show Urdu script reliably.
 * No dependencies on purpose: util.js and state.js require this module.
 */

const LANGS = Object.freeze(['roman', 'en', 'ur']);
const DEFAULT_LANG = 'roman';

// [key, roman, en, ur]
const ROWS = [
  // ---------------------------------------------------------------------------------------- http / server
  ['err.internal', 'Andaruni ghalti hui', 'Internal error', 'اندرونی خرابی ہوئی'],
  ['err.internalWith', 'Andaruni ghalti: {message}', 'Internal error: {message}', 'اندرونی خرابی: {message}'],
  ['err.tooLarge', 'Request bohat bari hai (1 MB se zyada)', 'Request is too large (more than 1 MB)', 'درخواست بہت بڑی ہے (1 MB سے زیادہ)'],
  ['http.indexMissing', 'index.html nahi mila', 'index.html not found', 'index.html نہیں ملا'],
  ['http.notFound', 'Nahi mila', 'Not found', 'نہیں ملا'],
  ['err.badToken', 'Token galat hai — page reload karein', 'Invalid token — reload the page', 'Token غلط ہے — صفحہ دوبارہ لوڈ کریں'],
  ['err.method', 'Ye method nahi chalta', 'This method is not supported', 'یہ method نہیں چلتا'],
  ['err.contentType', 'Sirf JSON (application/json) bheja ja sakta hai', 'Only JSON (application/json) can be sent', 'صرف JSON (application/json) بھیجا جا سکتا ہے'],
  ['err.badJson', 'JSON samajh nahi aaya', 'Could not parse the JSON', 'JSON سمجھ نہیں آیا'],
  ['err.jsonObject', 'JSON object chahiye', 'A JSON object is required', 'JSON object چاہیے'],
  ['err.apiNotFound', 'Ye API nahi mili', 'This API was not found', 'یہ API نہیں ملی'],
  ['err.extraPathKind', 'Sirf php.exe, composer .phar, ya mysqld.exe / mariadbd.exe ka path dein', 'Give the path of php.exe, a composer .phar, or mysqld.exe / mariadbd.exe only', 'صرف php.exe، composer .phar، یا mysqld.exe / mariadbd.exe کا path دیں'],
  ['err.pickFailed', 'Folder chunne wali window nahi khul saki', 'The folder picker window could not be opened', 'فولڈر چننے والی ونڈو نہیں کھل سکی'],
  ['pick.description', 'Project folder chunein', 'Choose the project folder', 'پروجیکٹ فولڈر چنیں'],
  ['err.confirmRequired', 'Start karne se pehle tasdeeq (confirm) zaroori hai', 'Confirmation is required before starting', 'شروع کرنے سے پہلے تصدیق (confirm) ضروری ہے'],
  ['msg.dbRemovedKeepData', 'List se hata diya. Data folder abhi bhi maujood hai: {datadir}', 'Removed from the list. The data folder still exists: {datadir}', 'فہرست سے ہٹا دیا گیا۔ ڈیٹا فولڈر ابھی بھی موجود ہے: {datadir}'],
  ['msg.dbRemoved', 'List se hata diya.', 'Removed from the list.', 'فہرست سے ہٹا دیا گیا۔'],
  ['err.jobNotFound', 'Ye job nahi mila (shayad panel dobara chala)', 'Job not found (the panel may have restarted)', 'یہ job نہیں ملا (شاید panel دوبارہ شروع ہوا)'],
  ['err.dumpDeleteOutside', 'Sirf dump folder ki .sql files delete ho sakti hain', 'Only .sql files in the dump folder can be deleted', 'صرف dump فولڈر کی .sql فائلیں ڈیلیٹ ہو سکتی ہیں'],
  ['err.noLauncher', 'PHP-Station.bat nahi mila: {path}', 'PHP-Station.bat not found: {path}', 'PHP-Station.bat نہیں ملا: {path}'],
  ['err.shortcutFailed', 'Shortcut nahi ban saka', 'Could not create the shortcut', 'Shortcut نہیں بن سکا'],
  ['shortcut.description', 'PHP Station - PHP projects aur DB servers', 'PHP Station - PHP projects and DB servers', 'PHP Station - PHP پروجیکٹس اور DB سرورز'],

  // ---------------------------------------------------------------------------------------- CLI (console)
  ['cli.startFailed', 'PHP Station start nahi hua. Log dekhein: {log}', 'PHP Station did not start. See the log: {log}', 'PHP Station شروع نہیں ہوا۔ Log دیکھیں: {log}'],
  ['cli.running', 'PHP Station chal raha hai: {url}', 'PHP Station is running: {url}', 'PHP Station چل رہا ہے: {url}'],
  ['cli.notRunning', 'PHP Station chal nahi raha (panel.json nahi mili).', 'PHP Station is not running (panel.json not found).', 'PHP Station نہیں چل رہا (panel.json نہیں ملی)۔'],
  ['cli.stopped', 'PHP Station band ho gaya. Projects aur DB servers chalte rahenge.', 'PHP Station stopped. Projects and DB servers keep running.', 'PHP Station بند ہو گیا۔ پروجیکٹس اور DB سرورز چلتے رہیں گے۔'],
  ['cli.stopFailed', 'PHP Station band nahi hua (process pehchana nahi gaya).', 'PHP Station did not stop (the process was not recognised).', 'PHP Station بند نہیں ہوا (process پہچانا نہیں گیا)۔'],
  ['cli.alreadyRunning', 'PHP Station pehle se chal raha hai (already running): {url}', 'PHP Station is already running: {url}', 'PHP Station پہلے سے چل رہا ہے: {url}'],
  ['cli.noPort', 'PHP Station ke liye koi port khali nahi ({from}-{to}).', 'No free port for PHP Station ({from}-{to}).', 'PHP Station کے لیے کوئی port خالی نہیں ({from}-{to})۔'],
  ['cli.usage', 'Istemal: node server.js --serve [--port N] [--data DIR] [--no-open] | --launch [--data DIR] [--no-open] | --stop [--data DIR]', 'Usage: node server.js --serve [--port N] [--data DIR] [--no-open] | --launch [--data DIR] [--no-open] | --stop [--data DIR]', 'استعمال: node server.js --serve [--port N] [--data DIR] [--no-open] | --launch [--data DIR] [--no-open] | --stop [--data DIR]'],

  // ---------------------------------------------------------------------------------------- jobs
  ['job.check', 'Jaanch: {name}', 'Check: {name}', 'جانچ: {name}'],
  ['job.lint', 'Lint: {name}', 'Lint: {name}', 'Lint: {name}'],
  ['job.clearCache', 'Cache saaf: {name}', 'Clear cache: {name}', 'Cache صاف: {name}'],
  ['job.dbCreate', 'Naya DB server: {name}', 'New DB server: {name}', 'نیا DB سرور: {name}'],
  ['job.dbStart', 'DB start: {label}', 'DB start: {label}', 'DB شروع: {label}'],
  ['job.dbStop', 'DB stop: {label}', 'DB stop: {label}', 'DB بند: {label}'],
  ['job.dbmove', 'DB move: {from} -> {to}', 'DB move: {from} -> {to}', 'DB منتقلی: {from} -> {to}'],
  ['job.runtimesScan', 'Runtimes scan', 'Runtimes scan', 'Runtimes اسکین'],
  ['job.unknownError', 'Nameloom ghalti', 'Unknown error', 'نامعلوم خرابی'],

  // ---------------------------------------------------------------------------------------- labels (used inside messages)
  ['label.path', 'Path', 'Path', 'Path'],
  ['label.projectFolder', 'Project folder', 'Project folder', 'پروجیکٹ فولڈر'],
  ['label.runtimeFolder', 'Runtime folder', 'Runtime folder', 'Runtime فولڈر'],
  ['label.dumpFile', 'Dump file', 'Dump file', 'Dump فائل'],
  ['label.dumpFolder', 'Dump folder', 'Dump folder', 'Dump فولڈر'],
  ['label.webPortRange', 'Web port range', 'Web port range', 'Web port رینج'],
  ['label.dbPortRange', 'DB port range', 'DB port range', 'DB port رینج'],

  // ---------------------------------------------------------------------------------------- paths (util)
  ['path.empty', '{label} khali hai', '{label} is empty', '{label} خالی ہے'],
  ['path.badChars', '{label} me ye nishan nahi chal sakte: " % ! ^ & | < >', '{label} must not contain these characters: " % ! ^ & | < >', '{label} میں یہ نشان نہیں چل سکتے: " % ! ^ & | < >'],
  ['path.notAbsolute', '{label} poora (absolute) hona chahiye, misal: D:\\Xampp8\\htdocs\\my-project', '{label} must be a full (absolute) path, e.g. D:\\Xampp8\\htdocs\\my-project', '{label} مکمل (absolute) ہونا چاہیے، مثال: D:\\Xampp8\\htdocs\\my-project'],
  ['path.tooLong', '{label} bohat lamba hai (240 huruf se kam hona chahiye)', '{label} is too long (must be under 240 characters)', '{label} بہت لمبا ہے (240 حروف سے کم ہونا چاہیے)'],
  ['path.notFound', '{label} nahi mila: {path}', '{label} not found: {path}', '{label} نہیں ملا: {path}'],
  ['path.notFolder', 'Ye folder nahi hai: {path}', 'This is not a folder: {path}', 'یہ فولڈر نہیں ہے: {path}'],
  ['path.notFile', 'Ye file nahi hai: {path}', 'This is not a file: {path}', 'یہ فائل نہیں ہے: {path}'],

  // ---------------------------------------------------------------------------------------- child processes (util)
  ['exit.timeout', 'Waqt khatam (timeout): {file}', 'Timed out: {file}', 'وقت ختم (timeout): {file}'],
  ['exit.dll', 'Zaroori DLL nahi mili (0xC0000135): {file}', 'A required DLL is missing (0xC0000135): {file}', 'ضروری DLL نہیں ملی (0xC0000135): {file}'],
  ['exit.crash', 'Program crash hua (0xC0000005): {file}', 'Program crashed (0xC0000005): {file}', 'پروگرام crash ہو گیا (0xC0000005): {file}'],
  ['exit.bitness', 'Program 32/64-bit mismatch (0xC000007B): {file}', 'Program 32/64-bit mismatch (0xC000007B): {file}', 'پروگرام میں 32/64-bit کا فرق (0xC000007B): {file}'],
  ['exit.failCode', 'Program fail hua (code 0x{hex}): {file}', 'Program failed (code 0x{hex}): {file}', 'پروگرام ناکام ہوا (code 0x{hex}): {file}'],
  ['run.notFound', 'Program nahi mila: {file}', 'Program not found: {file}', 'پروگرام نہیں ملا: {file}'],
  ['run.writeFail', 'File likhne me masla: {message}', 'Problem writing the file: {message}', 'فائل لکھنے میں مسئلہ: {message}'],
  ['run.readFail', 'File parhne me masla: {message}', 'Problem reading the file: {message}', 'فائل پڑھنے میں مسئلہ: {message}'],

  // ---------------------------------------------------------------------------------------- settings
  ['set.notObject', 'Settings ek object honi chahiye', 'Settings must be an object', 'Settings ایک object ہونی چاہیے'],
  ['set.panelPort', 'Panel port 1024 se 65535 ke darmiyan hona chahiye', 'Panel port must be between 1024 and 65535', 'Panel port کو 1024 اور 65535 کے درمیان ہونا چاہیے'],
  ['set.rangeList', '{name} do numbers ki list honi chahiye, misal [8000, 8999]', '{name} must be a list of two numbers, e.g. [8000, 8999]', '{name} دو نمبروں کی فہرست ہونی چاہیے، مثال [8000, 8999]'],
  ['set.rangeBad', '{name} galat hai: 1024 se 65535 ke darmiyan, pehla number doosre se chhota', '{name} is invalid: use 1024 to 65535, with the first number smaller than the second', '{name} غلط ہے: 1024 اور 65535 کے درمیان ہو، پہلا نمبر دوسرے سے چھوٹا ہو'],
  ['set.rangeTooBig', '{name} bohat bari hai (20000 ports se kam rakhein)', '{name} is too large (keep it under 20000 ports)', '{name} بہت بڑی ہے (20000 ports سے کم رکھیں)'],
  ['set.dirList', '{name} folders ki list honi chahiye', '{name} must be a list of folders', '{name} فولڈرز کی فہرست ہونی چاہیے'],
  ['set.dirListMax', '{name} me 50 se zyada folders nahi ho sakte', '{name} cannot have more than 50 folders', '{name} میں 50 سے زیادہ فولڈر نہیں ہو سکتے'],
  ['set.extraPaths', 'extraPaths files ki list honi chahiye (100 se kam)', 'extraPaths must be a list of files (fewer than 100)', 'extraPaths فائلوں کی فہرست ہونی چاہیے (100 سے کم)'],
  ['set.dumpDirIsFile', 'Dump folder ek file hai, folder nahi: {path}', 'Dump folder is a file, not a folder: {path}', 'Dump فولڈر ایک فائل ہے، فولڈر نہیں: {path}'],
  ['set.dbBindLocal', 'dbBindLocal true/false hona chahiye', 'dbBindLocal must be true or false', 'dbBindLocal کو true یا false ہونا چاہیے'],
  ['set.theme', 'Theme sirf black, silver ya auto ho sakti hai', 'Theme can only be black, silver or auto', 'Theme صرف black، silver یا auto ہو سکتی ہے'],
  ['set.lang', 'Zabaan sirf roman, en ya ur ho sakti hai', 'Language can only be roman, en or ur', 'زبان صرف roman، en یا ur ہو سکتی ہے'],
  ['set.unknown', 'Ye setting nahi pehchani: {key}', 'Unknown setting: {key}', 'یہ setting پہچانی نہیں گئی: {key}'],

  // ---------------------------------------------------------------------------------------- projects: records / validation
  ['err.shimInput', 'Shim ke liye project aur PHP chahiye', 'A shim needs a project and a PHP', 'Shim کے لیے پروجیکٹ اور PHP چاہیے'],
  ['err.projectNotFound', 'Ye project list me nahi mila', 'This project is not in the list', 'یہ پروجیکٹ فہرست میں نہیں ملا'],
  ['err.phpMissing', 'PHP {version} ab nahi mila (shayad switch-php se folder badla) — doosra PHP chunein', 'PHP {version} is no longer found (maybe switch-php changed the folder) — choose another PHP', 'PHP {version} اب نہیں ملا (شاید switch-php سے فولڈر بدلا) — دوسرا PHP چنیں'],
  ['err.choosePhp', 'PHP version chunein', 'Choose a PHP version', 'PHP version چنیں'],
  ['err.composerNotInList', 'Ye Composer list me nahi hai', 'This Composer is not in the list', 'یہ Composer فہرست میں نہیں ہے'],
  ['err.dbNotInList', 'Ye DB server list me nahi hai', 'This DB server is not in the list', 'یہ DB سرور فہرست میں نہیں ہے'],
  ['err.noWebPort', 'Web port range me koi port khali nahi (Settings me range barhayein)', 'No free port in the web port range (widen the range in Settings)', 'Web port رینج میں کوئی port خالی نہیں (Settings میں رینج بڑھائیں)'],
  ['err.alreadyAdded', 'Ye folder pehle se list me hai', 'This folder is already in the list', 'یہ فولڈر پہلے سے فہرست میں ہے'],
  ['err.stopToChange', 'Badalne ke liye pehle band karein', 'Stop it first to change this', 'تبدیل کرنے کے لیے پہلے بند کریں'],
  ['err.nameEmpty', 'Naam khali nahi ho sakta', 'Name cannot be empty', 'نام خالی نہیں ہو سکتا'],
  ['err.portRange', 'Port 1024 se 65535 ke darmiyan hona chahiye', 'Port must be between 1024 and 65535', 'Port کو 1024 اور 65535 کے درمیان ہونا چاہیے'],
  ['err.portUsedProject', 'Port {port} kisi aur project ka hai', 'Port {port} belongs to another project', 'Port {port} کسی اور پروجیکٹ کا ہے'],

  // ---------------------------------------------------------------------------------------- Laravel / PHP hints
  ['hint.tooNew', 'Laravel {laravel} PHP {php} par theek nahi chalta ({max} tak support hai)', 'Laravel {laravel} does not run properly on PHP {php} (supported up to {max})', 'Laravel {laravel} PHP {php} پر ٹھیک نہیں چلتا ({max} تک support ہے)'],
  ['hint.deprecations', 'Laravel {laravel} PHP {php} par deprecation/errors dega ({max} tak support hai)', 'Laravel {laravel} gives deprecations/errors on PHP {php} (supported up to {max})', 'Laravel {laravel} PHP {php} پر deprecation/errors دے گا ({max} تک support ہے)'],
  ['hint.notBuilt', 'Laravel {laravel} PHP {php} ke liye nahi bana ({max} tak support hai)', 'Laravel {laravel} is not made for PHP {php} (supported up to {max})', 'Laravel {laravel} PHP {php} کے لیے نہیں بنا ({max} تک support ہے)'],
  ['hint.needsMin', 'Laravel {laravel} ko kam az kam PHP {min} chahiye', 'Laravel {laravel} needs at least PHP {min}', 'Laravel {laravel} کو کم از کم PHP {min} چاہیے'],

  // ---------------------------------------------------------------------------------------- warnings (/api/state)
  ['warn.folderMissing', 'Folder nahi mila: {path}', 'Folder not found: {path}', 'فولڈر نہیں ملا: {path}'],
  ['warn.phpConstraint', 'composer.json PHP "{constraint}" mangta hai, chuna hua PHP {version} hai', 'composer.json requires PHP "{constraint}", the chosen PHP is {version}', 'composer.json کو PHP "{constraint}" چاہیے، چنا ہوا PHP {version} ہے'],
  ['warn.envPortMismatch', '.env me DB_PORT={envPort} hai, chuna hua server {serverPort} par hai', '.env has DB_PORT={envPort}, the chosen server is on {serverPort}', '.env میں DB_PORT={envPort} ہے، چنا ہوا سرور {serverPort} پر ہے'],
  ['warn.envPortUnset', '(nahi likha, 3306)', '(not set, 3306)', '(نہیں لکھا، 3306)'],
  ['warn.configCached', 'Config cache bana hua hai (bootstrap\\cache\\config.php) — .env ki tabdeeli tab tak asar nahi karegi jab tak "optimize:clear" na chalayein', 'Config cache exists (bootstrap\\cache\\config.php) — .env changes have no effect until you run "optimize:clear"', 'Config cache بنا ہوا ہے (bootstrap\\cache\\config.php) — جب تک "optimize:clear" نہ چلائیں، .env کی تبدیلی اثر نہیں کرے گی'],
  ['warn.noVendor', 'vendor folder nahi hai — Terminal se "composer install" chalayein', 'No vendor folder — run "composer install" from the Terminal', 'vendor فولڈر نہیں ہے — Terminal سے "composer install" چلائیں'],
  ['warn.sharedDatadir', 'Ye datadir in servers ke saath shared hai: {servers} — ek datadir par ek hi server chalna chahiye', 'This datadir is shared with these servers: {servers} — only one server should run on a datadir', 'یہ datadir ان سرورز کے ساتھ مشترک ہے: {servers} — ایک datadir پر ایک ہی سرور چلنا چاہیے'],
  ['warn.datadirNotSet', 'my.ini me datadir nahi likha', 'my.ini does not set a datadir', 'my.ini میں datadir نہیں لکھا'],
  ['warn.portClash', 'Port {port} ye bhi istemal karte hain: {servers}', 'Port {port} is also used by: {servers}', 'Port {port} یہ بھی استعمال کرتے ہیں: {servers}'],
  ['warn.noConfig', 'my.ini nahi mili', 'my.ini not found', 'my.ini نہیں ملی'],
  ['warn.noInstall', 'Is server ka MariaDB install ab scan me nahi mila', "This server's MariaDB install was not found in the last scan", 'اس سرور کا MariaDB install اب scan میں نہیں ملا'],

  // ---------------------------------------------------------------------------------------- projects: start / stop / externals / terminal / .env
  ['err.projectAlreadyStarting', 'Ye project pehle se start ho raha hai', 'This project is already starting', 'یہ پروجیکٹ پہلے سے شروع ہو رہا ہے'],
  ['err.projectFolderMissing', 'Project folder nahi mila: {path}', 'Project folder not found: {path}', 'پروجیکٹ فولڈر نہیں ملا: {path}'],
  ['err.dbStopped', 'DB server "{label}" band hai. Pehle use start karein?', 'DB server "{label}" is stopped. Start it first?', 'DB سرور "{label}" بند ہے۔ پہلے اسے شروع کریں؟'],
  ['err.phpSpawnFailed', 'PHP process start nahi hua', 'The PHP process did not start', 'PHP process شروع نہیں ہوا'],
  ['err.projectStartFailed', 'Project start nahi hua (port {port} nahi khula) — neeche log dekhein', 'The project did not start (port {port} did not open) — see the log below', 'پروجیکٹ شروع نہیں ہوا (port {port} نہیں کھلا) — نیچے log دیکھیں'],
  ['err.notVerified', 'Process verify nahi hua — kuch band nahi kiya', 'Could not verify the process — nothing was stopped', 'Process کی تصدیق نہیں ہوئی — کچھ بند نہیں کیا'],
  ['err.badPid', 'pid galat hai', 'Invalid pid', 'pid غلط ہے'],
  ['err.notExternal', 'Ye pid bahar se chalne wale PHP servers ki list me nahi hai', 'This pid is not in the list of externally started PHP servers', 'یہ pid باہر سے چلنے والے PHP سرورز کی فہرست میں نہیں ہے'],
  ['err.noProjectPath', 'Is server ka project folder pehchana nahi ja saka', "Could not identify this server's project folder", 'اس سرور کا پروجیکٹ فولڈر پہچانا نہیں جا سکا'],
  ['err.noPhpRuntime', 'Koi PHP runtime nahi mila — pehle runtimes scan karein', 'No PHP runtime found — scan runtimes first', 'کوئی PHP runtime نہیں ملا — پہلے runtimes scan کریں'],
  ['err.stopFailed', 'Band nahi hua: {output}', 'Did not stop: {output}', 'بند نہیں ہوا: {output}'],
  ['err.badTerminalAction', 'Ye terminal action nahi pehchana', 'Unknown terminal action', 'یہ terminal action پہچانا نہیں گیا'],
  ['err.noComposer', 'Is project ke liye Composer nahi chuna — pehle Composer chunein', 'No Composer chosen for this project — choose a Composer first', 'اس پروجیکٹ کے لیے Composer نہیں چنا — پہلے Composer چنیں'],
  ['err.dataDirUnsafe', 'Data folder ke path me aise nishan hain jo terminal me nahi chal sakte', 'The data folder path contains characters that cannot be used in a terminal', 'Data فولڈر کے path میں ایسے نشان ہیں جو terminal میں نہیں چل سکتے'],
  ['err.badPort', 'Port galat hai', 'Invalid port', 'Port غلط ہے'],
  ['err.badHost', 'Host galat hai', 'Invalid host', 'Host غلط ہے'],
  ['err.badDbName', 'Database ka naam galat hai', 'Invalid database name', 'Database کا نام غلط ہے'],
  ['err.noEnv', 'Is project me .env file nahi hai', 'This project has no .env file', 'اس پروجیکٹ میں .env فائل نہیں ہے'],
  ['msg.configClearFailed', 'config:clear fail hua: {line}', 'config:clear failed: {line}', 'config:clear ناکام ہوا: {line}'],
  ['msg.configClearNoPhp', 'PHP nahi mila, config:clear nahi chala — khud "php artisan config:clear" chalayein', 'PHP not found, config:clear did not run — run "php artisan config:clear" yourself', 'PHP نہیں ملا، config:clear نہیں چلا — خود "php artisan config:clear" چلائیں'],

  // ---------------------------------------------------------------------------------------- terminal.cmd (console)
  ['term.noComposer', 'koi nahi chuna', 'none chosen', 'کوئی نہیں چنا'],
  ['term.noDb', 'koi nahi (.env jaisa)', 'none (as in .env)', 'کوئی نہیں (.env کے مطابق)'],
  ['term.phpHint', '"php" aur "composer" yahan isi project ke versions hain.', '"php" and "composer" here are the versions of this project.', '"php" اور "composer" یہاں اسی پروجیکٹ کے versions ہیں۔'],

  // ---------------------------------------------------------------------------------------- check job
  ['check.phpFound', 'PHP {version} mila: {path}', 'Found PHP {version}: {path}', 'PHP {version} ملا: {path}'],
  ['check.phpFoundRelocated', 'PHP {version} mila: {path} (relocated php.ini)', 'Found PHP {version}: {path} (relocated php.ini)', 'PHP {version} ملا: {path} (relocated php.ini)'],
  ['check.constraintOk', 'composer.json PHP "{constraint}" — PHP {version} theek hai', 'composer.json PHP "{constraint}" — PHP {version} is fine', 'composer.json PHP "{constraint}" — PHP {version} ٹھیک ہے'],
  ['check.constraintBad', 'composer.json PHP "{constraint}" mangta hai — PHP {version} us me nahi aata', 'composer.json requires PHP "{constraint}" — PHP {version} does not match it', 'composer.json کو PHP "{constraint}" چاہیے — PHP {version} اس میں نہیں آتا'],
  ['check.constraintUnknown', 'composer.json ki PHP requirement samajh nahi aayi: "{constraint}"', 'Could not understand the composer.json PHP requirement: "{constraint}"', 'composer.json کی PHP requirement سمجھ نہیں آئی: "{constraint}"'],
  ['check.noConstraint', 'composer.json me PHP requirement nahi likhi', 'composer.json has no PHP requirement', 'composer.json میں PHP requirement نہیں لکھی'],
  ['check.laravelOk', 'Laravel {laravel} aur PHP {version} saath chal sakte hain', 'Laravel {laravel} and PHP {version} work together', 'Laravel {laravel} اور PHP {version} ساتھ چل سکتے ہیں'],
  ['check.noVendor', 'vendor folder nahi hai', 'No vendor folder', 'vendor فولڈر نہیں ہے'],
  ['check.vendorLockMismatch', 'vendor me Laravel {installed} hai magar composer.lock me {locked}', 'vendor has Laravel {installed} but composer.lock has {locked}', 'vendor میں Laravel {installed} ہے مگر composer.lock میں {locked}'],
  ['check.vendorLockOk', 'vendor aur composer.lock barabar: Laravel {installed}', 'vendor and composer.lock match: Laravel {installed}', 'vendor اور composer.lock برابر: Laravel {installed}'],
  ['check.vendorConstraintBad', 'vendor me Laravel {installed} hai, composer.json "{constraint}" mangta hai', 'vendor has Laravel {installed}, composer.json requires "{constraint}"', 'vendor میں Laravel {installed} ہے، composer.json کو "{constraint}" چاہیے'],
  ['check.vendorOk', 'vendor folder maujood hai', 'vendor folder exists', 'vendor فولڈر موجود ہے'],
  ['check.noComposer', 'Koi Composer nahi mila — platform check nahi hua', 'No Composer found — platform check skipped', 'کوئی Composer نہیں ملا — platform check نہیں ہوا'],
  ['check.composerFallback', 'Project ke liye Composer nahi chuna, {version} se check kar rahe hain', 'No Composer chosen for the project, checking with {version}', 'پروجیکٹ کے لیے Composer نہیں چنا، {version} سے check کر رہے ہیں'],
  ['check.platformOk', 'composer check-platform-reqs: sab theek ({count} checks)', 'composer check-platform-reqs: all good ({count} checks)', 'composer check-platform-reqs: سب ٹھیک ({count} checks)'],
  ['check.platformFailed', 'check-platform-reqs nahi chala: {reason}', 'check-platform-reqs did not run: {reason}', 'check-platform-reqs نہیں چلا: {reason}'],
  ['check.extMissing', 'Ye extensions PHP {version} me on nahi: {list}', 'These extensions are not enabled in PHP {version}: {list}', 'یہ extensions PHP {version} میں on نہیں: {list}'],
  ['check.extOk', 'Zaroori extensions mojood: {list}', 'Required extensions present: {list}', 'ضروری extensions موجود: {list}'],
  ['check.envHostNotLocal', '.env DB_HOST={host} local nahi hai', '.env DB_HOST={host} is not local', '.env DB_HOST={host} local نہیں ہے'],
  ['check.envPortOk', 'DB_PORT chune hue server ({label}) se milta hai', 'DB_PORT matches the chosen server ({label})', 'DB_PORT چنے ہوئے سرور ({label}) سے ملتا ہے'],
  ['check.dbStopped', 'DB server "{label}" band hai', 'DB server "{label}" is stopped', 'DB سرور "{label}" بند ہے'],
  ['check.dbRunning', 'DB server chal raha hai (pid {pid})', 'DB server is running (pid {pid})', 'DB سرور چل رہا ہے (pid {pid})'],
  ['check.dbExists', 'Database "{db}" maujood hai', 'Database "{db}" exists', 'Database "{db}" موجود ہے'],
  ['check.dbMissing', 'Database "{db}" is server par nahi hai', 'Database "{db}" is not on this server', 'Database "{db}" اس سرور پر نہیں ہے'],
  ['check.dbCheckFailed', 'Database check nahi hua: {message}', 'Database check failed: {message}', 'Database check نہیں ہوا: {message}'],
  ['check.noDbServer', 'Is project ke liye DB server nahi chuna (.env jaisa chalega)', 'No DB server chosen for this project (it runs as set in .env)', 'اس پروجیکٹ کے لیے DB سرور نہیں چنا (.env کے مطابق چلے گا)'],
  ['check.noEnv', '.env file nahi hai', 'No .env file', '.env فائل نہیں ہے'],
  ['check.configCached', 'Config cache bana hua hai — .env ki tabdeeliyan asar nahi karengi', 'Config cache exists — .env changes will have no effect', 'Config cache بنا ہوا ہے — .env کی تبدیلیاں اثر نہیں کریں گی'],
  ['check.nextSteps', 'Agla kaam: {list}', 'Next steps: {list}', 'اگلا کام: {list}'],
  ['next.choosePhpOnCard', 'Project card par doosra PHP chunein', 'Choose another PHP on the project card', 'پروجیکٹ کارڈ پر دوسرا PHP چنیں'],
  ['next.chooseMatchingPhp', 'Mutabiq PHP chunein (★ wale)', 'Choose a matching PHP (the ★ ones)', 'مطابقت رکھنے والا PHP چنیں (★ والے)'],
  ['next.chooseLaravelPhp', 'Laravel ke mutabiq PHP version chunein', 'Choose a PHP version that suits this Laravel', 'Laravel کے مطابق PHP version چنیں'],
  ['next.composerInstall', 'Terminal > composer install chalayein', 'Run Terminal > composer install', 'Terminal > composer install چلائیں'],
  ['next.composerInstallAgain', 'composer install dobara chalayein', 'Run composer install again', 'composer install دوبارہ چلائیں'],
  ['next.enableExtOrPhp', 'Missing extensions php.ini me on karein ya doosra PHP chunein', 'Enable the missing extensions in php.ini or choose another PHP', 'غائب extensions کو php.ini میں on کریں یا دوسرا PHP چنیں'],
  ['next.enableExt', 'php.ini me extension on karein: {list}', 'Enable these extensions in php.ini: {list}', 'php.ini میں extension on کریں: {list}'],
  ['next.writeEnvPort', '".env me DB_PORT={port} likh dein" button dabayein', 'Use the button that writes DB_PORT={port} to .env', 'وہ بٹن دبائیں جو .env میں DB_PORT={port} لکھتا ہے'],
  ['next.startDbServer', 'DB Servers page se server start karein', 'Start the server from the DB Servers page', 'DB Servers صفحے سے سرور شروع کریں'],
  ['next.moveOrMigrate', 'DB Move se purane server se database layein, ya migrate chalayein', 'Bring the database from the old server with DB Move, or run migrate', 'DB Move سے پرانے سرور سے database لائیں، یا migrate چلائیں'],
  ['next.makeEnv', '.env.example se .env banayein', 'Create .env from .env.example', '.env.example سے .env بنائیں'],
  ['next.optimizeClear', 'Terminal > optimize:clear chalayein', 'Run Terminal > optimize:clear', 'Terminal > optimize:clear چلائیں'],
  ['next.allGood', 'Sab theek lag raha hai — project chalayein', 'Everything looks fine — start the project', 'سب ٹھیک لگ رہا ہے — پروجیکٹ چلائیں'],

  // ---------------------------------------------------------------------------------------- lint / clear-cache jobs
  ['lint.start', '{count} PHP files PHP {version} se check ho rahi hain (resources\\views Blade hain, skip)', 'Checking {count} PHP files with PHP {version} (resources\\views are Blade, skipped)', '{count} PHP فائلیں PHP {version} سے check ہو رہی ہیں (resources\\views میں Blade ہے، skip)'],
  ['lint.progress', '{done} / {total} files check ho gayin', '{done} / {total} files checked', '{done} / {total} فائلیں check ہو گئیں'],
  ['lint.noErrors', 'Koi syntax error nahi mila', 'No syntax errors found', 'کوئی syntax error نہیں ملا'],
  ['err.notLaravel', 'Ye Laravel project nahi (artisan file nahi)', 'Not a Laravel project (no artisan file)', 'یہ Laravel پروجیکٹ نہیں (artisan فائل نہیں)'],
  ['err.optimizeClearFailed', 'optimize:clear fail hua: {line}', 'optimize:clear failed: {line}', 'optimize:clear ناکام ہوا: {line}'],
  ['clear.done', 'Cache saaf ho gaya', 'Cache cleared', 'Cache صاف ہو گیا'],

  // ---------------------------------------------------------------------------------------- DB servers
  ['err.dbNotFound', 'Ye DB server list me nahi mila (runtimes dobara scan karein)', 'This DB server is not in the list (scan runtimes again)', 'یہ DB سرور فہرست میں نہیں ملا (runtimes دوبارہ scan کریں)'],
  ['err.noClient', 'Koi MariaDB/MySQL client (mariadb.exe / mysql.exe) nahi mila', 'No MariaDB/MySQL client (mariadb.exe / mysql.exe) found', 'کوئی MariaDB/MySQL client (mariadb.exe / mysql.exe) نہیں ملا'],
  ['err.needCreds', 'Database ka user/password chahiye (access denied)', 'A database user/password is needed (access denied)', 'Database کا user/password چاہیے (access denied)'],
  ['err.dbConnect', 'Server se connect nahi hua (port {port}): {line}', 'Could not connect to the server (port {port}): {line}', 'سرور سے connect نہیں ہوا (port {port}): {line}'],
  ['err.queryFailed', 'Query fail hui: {line}', 'Query failed: {line}', 'Query ناکام ہوئی: {line}'],
  ['err.dbNotRunning', 'Ye DB server chal nahi raha — pehle start karein', 'This DB server is not running — start it first', 'یہ DB سرور نہیں چل رہا — پہلے شروع کریں'],
  ['err.noServerExe', 'Is install me server (mysqld/mariadbd) nahi hai', 'This install has no server (mysqld/mariadbd)', 'اس install میں سرور (mysqld/mariadbd) نہیں ہے'],
  ['err.noConfigStart', 'my.ini nahi mili — server start nahi ho sakta', 'my.ini not found — the server cannot start', 'my.ini نہیں ملی — سرور شروع نہیں ہو سکتا'],
  ['err.dbAlreadyStarting', 'Ye server pehle se start ho raha hai', 'This server is already starting', 'یہ سرور پہلے سے شروع ہو رہا ہے'],
  ['db.alreadyRunning', '{label} pehle se chal raha hai (pid {pid})', '{label} is already running (pid {pid})', '{label} پہلے سے چل رہا ہے (pid {pid})'],
  ['err.portBusyPid', 'Port {port} pehle se istemal me hai (pid {pid}{detail})', 'Port {port} is already in use (pid {pid}{detail})', 'Port {port} پہلے سے استعمال میں ہے (pid {pid}{detail})'],
  ['db.datadirMissing', 'Datadir nahi mila: {datadir}', 'Datadir not found: {datadir}', 'Datadir نہیں ملا: {datadir}'],
  ['db.datadirNotInIni', '(my.ini me nahi)', '(not in my.ini)', '(my.ini میں نہیں)'],
  ['err.datadirInUseBy', 'Isi datadir par "{label}" chal raha hai — ek datadir par ek hi server chalna chahiye', '"{label}" is running on this same datadir — only one server should run on a datadir', 'اسی datadir پر "{label}" چل رہا ہے — ایک datadir پر ایک ہی سرور چلنا چاہیے'],
  ['err.datadirLocked', 'Datadir koi aur program istemal kar raha hai (ibdata1 {code}) — start nahi kiya', 'Another program is using the datadir (ibdata1 {code}) — not started', 'Datadir کوئی اور پروگرام استعمال کر رہا ہے (ibdata1 {code}) — شروع نہیں کیا'],
  ['err.datadirLockedHint', 'Datadir koi aur program istemal kar raha hai (ibdata1 {code}) — shayad Laragon/XAMPP ka server admin mode me chal raha hai magar PHP Station uska port/login nahi pehchan saka. Us server ko wahan se band karein, ya PHP Station ke DB Servers page par usi server ko project ke liye chunein', 'Another program is using the datadir (ibdata1 {code}) — probably a Laragon/XAMPP server running as admin whose port/login PHP Station could not identify. Stop that server there, or choose it for the project on the DB Servers page', 'Datadir کوئی اور پروگرام استعمال کر رہا ہے (ibdata1 {code}) — شاید Laragon/XAMPP کا سرور admin موڈ میں چل رہا ہے مگر PHP Station اس کا port/login نہیں پہچان سکا۔ اس سرور کو وہیں سے بند کریں، یا DB Servers صفحے پر اسی سرور کو پروجیکٹ کے لیے چنیں'],
  ['note.dbUsingRunning', 'Isi data (datadir) par "{label}" pehle se port {port} par chal raha tha — PHP Station ne wahi istemal kiya', '"{label}" was already running on this data (datadir) at port {port} — PHP Station used it', 'اسی data (datadir) پر "{label}" پہلے سے port {port} پر چل رہا تھا — PHP Station نے وہی استعمال کیا'],
  ['note.dbAutoStarted', 'DB server "{label}" khud start kar diya (port {port})', 'DB server "{label}" was started automatically (port {port})', 'DB سرور "{label}" خود شروع کر دیا (port {port})'],
  ['note.dbEnvOverride', '.env me DB_PORT={envPort} hai magar server port {port} par hai — is run ke liye DB_PORT={port} diya (.env nahi badli)', '.env says DB_PORT={envPort} but the server is on port {port} — DB_PORT={port} was given for this run (.env unchanged)', '.env میں DB_PORT={envPort} ہے مگر سرور port {port} پر ہے — اس run کے لیے DB_PORT={port} دیا (.env نہیں بدلی)'],
  ['guard.noCsc', 'Windows ka .NET csc.exe nahi mila — shutdown guard nahi ban saka', 'Windows .NET csc.exe not found — the shutdown guard could not be built', 'ونڈوز کا .NET csc.exe نہیں ملا — شٹ ڈاؤن گارڈ نہیں بن سکا'],
  ['guard.buildFailed', 'Shutdown guard compile nahi hua: {message}', 'The shutdown guard did not compile: {message}', 'شٹ ڈاؤن گارڈ کمپائل نہیں ہوا: {message}'],
  ['bk.pruned', 'Purani automatic copy hatai: {name}', 'Removed an old automatic copy: {name}', 'پرانی خودکار نقل ہٹائی: {name}'],
  ['bk.stopFirst', 'Snapshot / restore sirf band server ka hota hai — pehle "{label}" band karein', 'Snapshots / restores need a stopped server — stop "{label}" first', 'سنیپ شاٹ / بحالی صرف بند سرور کی ہوتی ہے — پہلے "{label}" بند کریں'],
  ['bk.startFirst', 'Dump ke liye server chalna chahiye — pehle "{label}" start karein', 'Dumps need a running server — start "{label}" first', 'ڈمپ کے لیے سرور چلنا چاہیے — پہلے "{label}" شروع کریں'],
  ['bk.noSpace', 'Jagah kam hai: {need} chahiye, {free} khali ({dir})', 'Not enough disk space: {need} needed, {free} free ({dir})', 'جگہ کم ہے: {need} چاہیے، {free} خالی ({dir})'],
  ['bk.snapCopying', 'Data folder ki poori copy: {from} ({size}) -> {to}', 'Full copy of the data folder: {from} ({size}) -> {to}', 'ڈیٹا فولڈر کی پوری نقل: {from} ({size}) -> {to}'],
  ['bk.snapFailed', 'Snapshot nahi ban saka: {message}', 'The snapshot failed: {message}', 'سنیپ شاٹ نہیں بن سکا: {message}'],
  ['bk.snapDone', 'Snapshot ban gaya: {name} ({size}, {secs} second)', 'Snapshot taken: {name} ({size}, {secs} s)', 'سنیپ شاٹ بن گیا: {name} ({size}، {secs} سیکنڈ)'],
  ['bk.snapSkipBig', 'Data folder bara hai ({size} > {max}) — aaj ka automatic snapshot nahi liya (roz ka dump phir bhi hoga)', 'The data folder is large ({size} > {max}) — no automatic snapshot today (the daily dump still runs)', 'ڈیٹا فولڈر بڑا ہے ({size} > {max}) — آج کا خودکار سنیپ شاٹ نہیں لیا (روز کا ڈمپ پھر بھی ہوگا)'],
  ['bk.snapAutoFailed', 'Automatic snapshot nahi ban saka ({message}) — server phir bhi start ho raha hai', 'The automatic snapshot failed ({message}) — the server starts anyway', 'خودکار سنیپ شاٹ نہیں بن سکا ({message}) — سرور پھر بھی شروع ہو رہا ہے'],
  ['bk.badName', 'Backup ka naam theek nahi', 'Invalid backup name', 'بیک اپ کا نام درست نہیں'],
  ['bk.notFound', 'Ye backup nahi mila', 'Backup not found', 'یہ بیک اپ نہیں ملا'],
  ['bk.keepCurrent', 'Maujooda data mehfooz: {from} -> {to} (delete nahi hota)', 'Current data kept: {from} -> {to} (not deleted)', 'موجودہ ڈیٹا محفوظ: {from} -> {to} (حذف نہیں ہوتا)'],
  ['bk.restoring', 'Snapshot {name} wapas laaya ja raha hai…', 'Restoring snapshot {name}…', 'سنیپ شاٹ {name} واپس لایا جا رہا ہے…'],
  ['bk.restoreFailed', 'Restore nahi hua ({message}) — asal data wapas apni jagah rakh diya', 'The restore failed ({message}) — the original data was put back', 'بحالی نہیں ہوئی ({message}) — اصل ڈیٹا واپس اپنی جگہ رکھ دیا'],
  ['bk.restored', 'Snapshot {name} wapas aa gaya. Pehle wala data: {kept}', 'Snapshot {name} restored. Previous data: {kept}', 'سنیپ شاٹ {name} واپس آ گیا۔ پہلے والا ڈیٹا: {kept}'],
  ['bk.dumpStart', '{n} databases ka dump: {to}', 'Dumping {n} databases: {to}', '{n} ڈیٹا بیسز کا ڈمپ: {to}'],
  ['bk.dumpDbFailed', '{db} ka dump nahi hua: {error}', 'Dump of {db} failed: {error}', '{db} کا ڈمپ نہیں ہوا: {error}'],
  ['bk.dumpDone', 'Dump mukammal: {ok} theek, {failed} nakam', 'Dump finished: {ok} ok, {failed} failed', 'ڈمپ مکمل: {ok} درست، {failed} ناکام'],
  ['bk.dumpRestoring', '{db} ka dump naye database {target} me…', 'Importing the {db} dump into the new database {target}…', '{db} کا ڈمپ نئے ڈیٹا بیس {target} میں…'],
  ['bk.dumpRestoreFailed', 'Import nahi hua: {error}', 'Import failed: {error}', 'امپورٹ نہیں ہوا: {error}'],
  ['bk.dumpRestored', '{db} -> {target} wapas aa gaya', '{db} restored as {target}', '{db} -> {target} واپس آ گیا'],
  ['bk.busy', 'Aik backup/repair pehle se chal raha hai — us ke khatam hone ka intezar karein', 'A backup/repair is already running — wait for it to finish', 'ایک بیک اپ/مرمت پہلے سے چل رہی ہے — اس کے ختم ہونے کا انتظار کریں'],
  ['rep.ariaMoved', 'Aria log files hatayi (mehfooz): {list} -> {to}', 'Aria log files moved away (kept): {list} -> {to}', 'آریا لاگ فائلیں ہٹائیں (محفوظ): {list} -> {to}'],
  ['rep.ariaNone', 'Koi aria_log file nahi thi', 'No aria_log files found', 'کوئی آریا لاگ فائل نہیں تھی'],
  ['rep.noTool', '{tool} nahi mila — {table} repair nahi hua', '{tool} not found — {table} not repaired', '{tool} نہیں ملا — {table} کی مرمت نہیں ہوئی'],
  ['rep.stopFirst', 'Repair se pehle server band karein', 'Stop the server before repairing', 'مرمت سے پہلے سرور بند کریں'],
  ['rep.lockedHint', 'Log kehta hai data folder koi aur server istemal kar raha tha (XAMPP/Laragon). Woh band hai ya nahi, dekh lein', 'The log says another server (XAMPP/Laragon) was using the data folder. Make sure it is stopped', 'لاگ کہتا ہے ڈیٹا فولڈر کوئی اور سرور استعمال کر رہا تھا (XAMPP/Laragon)۔ دیکھ لیں وہ بند ہے یا نہیں'],
  ['rep.portHint', 'Log kehta hai port busy tha — DB Servers page se port badlein', 'The log says the port was busy — change the port on the DB Servers page', 'لاگ کہتا ہے پورٹ مصروف تھا — DB Servers صفحے سے پورٹ بدلیں'],
  ['rep.snapFirst', 'Repair se pehle poora snapshot…', 'Taking a full snapshot before the repair…', 'مرمت سے پہلے پورا سنیپ شاٹ…'],
  ['rep.nothingKnown', 'Log me koi jani pehchani kharabi nahi mili — sirf start aur check kiya jayega', 'No known problem in the log — the server is only started and checked', 'لاگ میں کوئی جانی پہچانی خرابی نہیں ملی — صرف شروع اور چیک کیا جائے گا'],
  ['rep.starting', 'Server start kar ke dekh rahe hain…', 'Starting the server to test…', 'سرور شروع کر کے دیکھ رہے ہیں…'],
  ['rep.needRescue', 'Server ab bhi start nahi hua: InnoDB data kharab lagta hai ({message}). "Data bachayein (rescue)" chalayein — snapshot mehfooz hai', 'The server still does not start: the InnoDB data looks damaged ({message}). Run "Rescue data" — the snapshot is safe', 'سرور اب بھی شروع نہیں ہوا: InnoDB ڈیٹا خراب لگتا ہے ({message})۔ "ڈیٹا بچائیں" چلائیں — سنیپ شاٹ محفوظ ہے'],
  ['rep.stillFails', 'Server ab bhi start nahi hua ({message}) — log dekhein; snapshot mehfooz hai', 'The server still does not start ({message}) — see the log; the snapshot is safe', 'سرور اب بھی شروع نہیں ہوا ({message}) — لاگ دیکھیں؛ سنیپ شاٹ محفوظ ہے'],
  ['rep.checking', '{tool} --auto-repair se saare tables check ho rahe hain…', 'Checking all tables with {tool} --auto-repair…', '{tool} --auto-repair سے سارے ٹیبل چیک ہو رہے ہیں…'],
  ['rep.checkProblems', 'Check me {n} masle mile (neeche)', 'The check reported {n} problems (below)', 'چیک میں {n} مسئلے ملے (نیچے)'],
  ['rep.checkOk', 'Saare tables theek hain', 'All tables are OK', 'سارے ٹیبل درست ہیں'],
  ['rep.checkSkipped', 'Table check nahi hua: {message}', 'Table check skipped: {message}', 'ٹیبل چیک نہیں ہوا: {message}'],
  ['rep.done', 'Repair mukammal, server chal raha hai. Pehle ka snapshot: {snapshot}', 'Repair finished, the server runs. Snapshot from before: {snapshot}', 'مرمت مکمل، سرور چل رہا ہے۔ پہلے کا سنیپ شاٹ: {snapshot}'],
  ['rep.copyForRescue', 'Rescue copy par hoga (asal data ko haath nahi): {to}', 'Rescue works on a copy (the original data is not touched): {to}', 'ریسکیو نقل پر ہوگا (اصل ڈیٹا کو ہاتھ نہیں): {to}'],
  ['rep.tryLevel', 'innodb_force_recovery={n} ke sath start (port {port})…', 'Starting with innodb_force_recovery={n} (port {port})…', 'innodb_force_recovery={n} کے ساتھ شروع (پورٹ {port})…'],
  ['rep.levelFailed', 'Level {n} par start nahi hua: {line}', 'Did not start at level {n}: {line}', 'لیول {n} پر شروع نہیں ہوا: {line}'],
  ['rep.highLevel', 'Level 4+ par kuch data adhoora ho sakta hai — is liye ye sirf copy par hota hai', 'From level 4 some data may be incomplete — which is why this only runs on a copy', 'لیول 4 سے کچھ ڈیٹا ادھورا ہو سکتا ہے — اسی لیے یہ صرف نقل پر ہوتا ہے'],
  ['rep.rescueFailed', 'Kisi bhi recovery level par server start nahi hua — snapshot aur work folder mehfooz hain', 'The server did not start at any recovery level — the snapshot and work folder are kept', 'کسی بھی ریکوری لیول پر سرور شروع نہیں ہوا — سنیپ شاٹ اور ورک فولڈر محفوظ ہیں'],
  ['rep.rescueUp', 'Level {n} par server chal gaya — databases nikaale ja rahe hain', 'The server runs at level {n} — exporting the databases', 'لیول {n} پر سرور چل گیا — ڈیٹا بیسز نکالے جا رہے ہیں'],
  ['rep.dumpPartial', '{db} poora nahi nikla: {error}', '{db} could not be exported completely: {error}', '{db} پورا نہیں نکلا: {error}'],
  ['rep.newServer', 'Naya DB server tayyar: {label} (port {port}) — projects ko is par switch karein', 'New DB server ready: {label} (port {port}) — switch the projects to it', 'نیا DB سرور تیار: {label} (پورٹ {port}) — پروجیکٹس کو اس پر منتقل کریں'],
  ['rep.rebuilt', '{table} repair nahi ho saka — MariaDB ke template se naya bana diya (purani files: {to}). Is table ki purani settings/users wapas chahiye hon to wahi files hain', '{table} could not be repaired — rebuilt from the MariaDB template (old files: {to}). Its old settings/users are in those files', '{table} کی مرمت نہیں ہو سکی — MariaDB کے ٹیمپلیٹ سے نیا بنا دیا (پرانی فائلیں: {to})۔ اس ٹیبل کی پرانی سیٹنگز/یوزرز انہی فائلوں میں ہیں'],
  ['bk.dumpPartial', '{db}: {size} — baqi sab ka backup ban gaya, magar ye tables kharab hain aur shamil nahi: {tables}', '{db}: {size} — everything else was backed up, but these tables are broken and not included: {tables}', '{db}: {size} — باقی سب کا بیک اپ بن گیا، مگر یہ ٹیبل خراب ہیں اور شامل نہیں: {tables}'],
  ['rep.noTemplate','Is server ke liye system table ka template nahi ban sakta (install-db nahi mila)', 'No system table template for this server (install-db not found)', 'اس سرور کے لیے سسٹم ٹیبل کا ٹیمپلیٹ نہیں بن سکتا (install-db نہیں ملا)'],
  ['rep.templateFailed', 'System table template nahi bana: {message}', 'The system table template failed: {message}', 'سسٹم ٹیبل ٹیمپلیٹ نہیں بنا: {message}'],
  ['job.dailyDump', 'Roz ka backup: {label}', 'Daily backup: {label}', 'روز کا بیک اپ: {label}'],
  ['job.snapshot', 'Snapshot: {label}', 'Snapshot: {label}', 'سنیپ شاٹ: {label}'],
  ['job.dump', 'Dump: {label}', 'Dump: {label}', 'ڈمپ: {label}'],
  ['job.restoreSnapshot', 'Restore: {label} <- {name}', 'Restore: {label} <- {name}', 'بحالی: {label} <- {name}'],
  ['job.restoreDump', 'Restore: {db} -> {target}', 'Restore: {db} -> {target}', 'بحالی: {db} -> {target}'],
  ['job.repair', 'Repair: {label}', 'Repair: {label}', 'مرمت: {label}'],
  ['job.rescue', 'Data rescue: {label}', 'Data rescue: {label}', 'ڈیٹا ریسکیو: {label}'],
  ['set.snapshotOnStart', 'snapshotOnStart sirf daily, always ya off', 'snapshotOnStart must be daily, always or off', 'snapshotOnStart صرف daily، always یا off'],
  ['set.numberRange', '{key} {lo} se {hi} tak hona chahiye', '{key} must be between {lo} and {hi}', '{key} کو {lo} سے {hi} تک ہونا چاہیے'],
  ['set.boolean', '{key} true/false hona chahiye', '{key} must be true or false', '{key} کو true یا false ہونا چاہیے'],
  ['db.precheckOk','Jaanch theek: port {port} khali, datadir {datadir}', 'Checks passed: port {port} is free, datadir {datadir}', 'جانچ ٹھیک: port {port} خالی، datadir {datadir}'],
  ['err.dbSpawnFailed', 'Server process start nahi hua', 'The server process did not start', 'سرور process شروع نہیں ہوا'],
  ['db.waitingPort', 'Server process chala (pid {pid}) — port {port} khulne ka intezar (60 s tak)', 'Server process started (pid {pid}) — waiting for port {port} to open (up to 60 s)', 'سرور process چل پڑا (pid {pid}) — port {port} کھلنے کا انتظار (60 s تک)'],
  ['err.dbNotReady', 'Server 60 second me port {port} par tayyar nahi hua (abhi bhi chal raha hai, pid {pid}) — Log dekhein', 'The server was not ready on port {port} within 60 seconds (still running, pid {pid}) — see the Log', 'سرور 60 سیکنڈ میں port {port} پر تیار نہیں ہوا (ابھی بھی چل رہا ہے، pid {pid}) — Log دیکھیں'],
  ['err.dbExitedEarly', 'Server start hote hi band ho gaya — Log dekhein', 'The server stopped right after starting — see the Log', 'سرور شروع ہوتے ہی بند ہو گیا — Log دیکھیں'],
  ['db.confirming', 'Port {port} khul gaya — server ke mukammal tayyar hone ki tasdeeq (15 s tak)', 'Port {port} is open — confirming the server is fully up (up to 15 s)', 'Port {port} کھل گیا — سرور کے مکمل تیار ہونے کی تصدیق (15 s تک)'],
  ['err.dbNotStable', 'Server ne port {port} khola magar tayyar nahi hua (abhi bhi chal raha hai, pid {pid}) — Log dekhein', 'The server opened port {port} but did not become ready (still running, pid {pid}) — see the Log', 'سرور نے port {port} کھولا مگر تیار نہیں ہوا (ابھی بھی چل رہا ہے، pid {pid}) — Log دیکھیں'],
  ['db.started', '{label} chal gaya — port {port}, pid {pid}', '{label} is running — port {port}, pid {pid}', '{label} چل گیا — port {port}، pid {pid}'],
  ['err.notRunning', 'Ye server chal nahi raha', 'This server is not running', 'یہ سرور نہیں چل رہا'],
  ['err.notControllable', 'Ye server admin/Laragon ne chalaya hai — wahin se band karein', 'This server was started by an admin/Laragon — stop it from there', 'یہ سرور admin/Laragon نے چلایا ہے — وہیں سے بند کریں'],
  ['db.stopped', 'Server band ho gaya (tareeqa: {method})', 'Server stopped (method: {method})', 'سرور بند ہو گیا (طریقہ: {method})'],
  ['db.eventSetting', 'Graceful shutdown: MySQLShutdown{pid} event set kar rahe hain', 'Graceful shutdown: setting the MySQLShutdown{pid} event', 'Graceful shutdown: MySQLShutdown{pid} event set کر رہے ہیں'],
  ['db.eventSet', 'Event set ho gaya — server ke band hone ka intezar (90 s tak)', 'Event set — waiting for the server to stop (up to 90 s)', 'Event set ہو گیا — سرور کے بند ہونے کا انتظار (90 s تک)'],
  ['db.eventTimeout', 'Server 90 second me band nahi hua', 'The server did not stop within 90 seconds', 'سرور 90 سیکنڈ میں بند نہیں ہوا'],
  ['db.eventFailed', 'Event kaam nahi aaya: {error}', 'The event did not work: {error}', 'Event کام نہیں آیا: {error}'],
  ['err.matchLost', 'Process ab is server se match nahi karta — kuch nahi kiya', 'The process no longer matches this server — nothing was done', 'Process اب اس سرور سے match نہیں کرتا — کچھ نہیں کیا'],
  ['db.adminDenied', 'Admin shutdown: access denied (user/password chahiye)', 'Admin shutdown: access denied (user/password needed)', 'Admin shutdown: access denied (user/password چاہیے)'],
  ['db.adminTimeout', 'Admin shutdown ke baad bhi server 90 second me band nahi hua', 'Even after the admin shutdown the server did not stop within 90 seconds', 'Admin shutdown کے بعد بھی سرور 90 سیکنڈ میں بند نہیں ہوا'],
  ['db.adminFailed', 'Admin shutdown fail: {error}', 'Admin shutdown failed: {error}', 'Admin shutdown ناکام: {error}'],
  ['db.forcing', 'Zabardasti band kar rahe hain (taskkill pid {pid})', 'Force stopping (taskkill pid {pid})', 'زبردستی بند کر رہے ہیں (taskkill pid {pid})'],
  ['err.forceFailed', 'Zabardasti band bhi nahi hua: {output}', 'Force stop did not work either: {output}', 'زبردستی بھی بند نہیں ہوا: {output}'],
  ['err.needCredsStop', 'Server band karne ke liye DB user/password chahiye', 'A DB user/password is needed to stop the server', 'سرور بند کرنے کے لیے DB user/password چاہیے'],
  ['err.gracefulFailed', 'Server graceful tareeqe se band nahi hua — "Zabardasti band karein" ka option hai (data kharab ho sakta hai)', 'The server did not stop gracefully — there is a "Force stop" option (data may get damaged)', 'سرور graceful طریقے سے بند نہیں ہوا — "زبردستی بند کریں" کا option موجود ہے (ڈیٹا خراب ہو سکتا ہے)'],
  ['err.installNotFound', 'Ye install nahi mila (runtimes scan karein)', 'Install not found (scan runtimes)', 'یہ install نہیں ملا (runtimes scan کریں)'],
  ['err.installNotMariadb', 'Naya server sirf MariaDB install se banta hai', 'A new server can only be made from a MariaDB install', 'نیا سرور صرف MariaDB install سے بنتا ہے'],
  ['err.noInstallDb', 'Is install me mariadb-install-db / mysql_install_db nahi hai', 'This install has no mariadb-install-db / mysql_install_db', 'اس install میں mariadb-install-db / mysql_install_db نہیں ہے'],
  ['err.badInstanceName', 'Naam sirf chhote angrezi huruf, number aur - (2 se 30 huruf)', 'Name: lowercase English letters, digits and - only (2 to 30 characters)', 'نام میں صرف چھوٹے انگریزی حروف، نمبر اور - (2 سے 30 حروف)'],
  ['err.instanceExists', 'Is naam ka server pehle se hai', 'A server with this name already exists', 'اس نام کا سرور پہلے سے ہے'],
  ['err.portUsedDb', 'Port {port} kisi aur DB server ka hai', 'Port {port} belongs to another DB server', 'Port {port} کسی اور DB سرور کا ہے'],
  ['err.portBusy', 'Port {port} abhi istemal me hai', 'Port {port} is in use right now', 'Port {port} ابھی استعمال میں ہے'],
  ['err.datadirExists', 'Datadir pehle se maujood hai: {datadir}', 'Datadir already exists: {datadir}', 'Datadir پہلے سے موجود ہے: {datadir}'],
  ['db.installDbRunning', '{tool} chala rahe hain: datadir {datadir}, port {port}', 'Running {tool}: datadir {datadir}, port {port}', '{tool} چلا رہے ہیں: datadir {datadir}، port {port}'],
  ['err.createFailed', 'Naya datadir nahi bana: {message}', 'The new datadir was not created: {message}', 'نیا datadir نہیں بنا: {message}'],
  ['db.created', 'Naya DB server "{name}" ban gaya (port {port}). Start karne ke liye Start dabayein.', 'New DB server "{name}" created (port {port}). Press Start to start it.', 'نیا DB سرور "{name}" بن گیا (port {port})۔ شروع کرنے کے لیے Start دبائیں۔'],
  ['err.labelText', 'Label text hona chahiye', 'Label must be text', 'Label متن ہونا چاہیے'],
  ['err.notRemovable', 'Sirf panel ke banaye hue server list se hataye ja sakte hain', 'Only servers created by the panel can be removed from the list', 'صرف panel کے بنائے ہوئے سرور فہرست سے ہٹائے جا سکتے ہیں'],
  ['err.stopServerFirst', 'Pehle server band karein', 'Stop the server first', 'پہلے سرور بند کریں'],
  ['log.empty', 'Abhi koi log nahi.', 'No log yet.', 'ابھی کوئی log نہیں۔'],

  // ---------------------------------------------------------------------------------------- DB move
  ['move.srcNotRunning', 'Purana server "{label}" chal nahi raha — pehle start karein', 'Old server "{label}" is not running — start it first', 'پرانا سرور "{label}" نہیں چل رہا — پہلے شروع کریں'],
  ['move.dstNotRunning', 'Naya server "{label}" chal nahi raha — pehle start karein', 'New server "{label}" is not running — start it first', 'نیا سرور "{label}" نہیں چل رہا — پہلے شروع کریں'],
  ['move.chooseServers', 'Dono servers chunein', 'Choose both servers', 'دونوں سرور چنیں'],
  ['move.badFromName', 'Purane database ka naam galat hai (sirf A-Z a-z 0-9 _ $ -)', 'Invalid old database name (only A-Z a-z 0-9 _ $ -)', 'پرانے database کا نام غلط ہے (صرف A-Z a-z 0-9 _ $ -)'],
  ['move.badToName', 'Naye database ka naam galat hai (sirf A-Z a-z 0-9 _ $ -)', 'Invalid new database name (only A-Z a-z 0-9 _ $ -)', 'نئے database کا نام غلط ہے (صرف A-Z a-z 0-9 _ $ -)'],
  ['move.sameTarget', 'Wohi server aur wohi naam — move ka koi matlab nahi', 'Same server and same name — nothing to move', 'وہی سرور اور وہی نام — منتقلی کا کوئی مطلب نہیں'],
  ['move.projectNotFound', 'Project nahi mila', 'Project not found', 'پروجیکٹ نہیں ملا'],
  ['move.servers', 'Purana: {from} (port {fromPort}) · Naya: {to} (port {toPort})', 'Old: {from} (port {fromPort}) · New: {to} (port {toPort})', 'پرانا: {from} (port {fromPort}) · نیا: {to} (port {toPort})'],
  ['move.sourceMissing', 'Purane server par database "{db}" nahi mila', 'Database "{db}" not found on the old server', 'پرانے سرور پر database "{db}" نہیں ملا'],
  ['move.targetExists', 'Naye server par "{db}" pehle se maujood hai — kabhi overwrite nahi hota. Naya naam chunein.', '"{db}" already exists on the new server — it is never overwritten. Choose a new name.', 'نئے سرور پر "{db}" پہلے سے موجود ہے — کبھی overwrite نہیں ہوتا۔ نیا نام چنیں۔'],
  ['move.checkOk', '"{from}" mila; naye server par "{to}" abhi nahi hai', 'Found "{from}"; "{to}" does not exist on the new server yet', '"{from}" مل گیا؛ نئے سرور پر "{to}" ابھی نہیں ہے'],
  ['move.sourceCounts', 'Purane DB me {tables} tables, {rows} rows, {views} views, {routines} routines, {triggers} triggers', 'Old DB has {tables} tables, {rows} rows, {views} views, {routines} routines, {triggers} triggers', 'پرانے DB میں {tables} tables، {rows} rows، {views} views، {routines} routines، {triggers} triggers'],
  ['move.noDumpTool', 'mariadb-dump / mysqldump nahi mila', 'mariadb-dump / mysqldump not found', 'mariadb-dump / mysqldump نہیں ملا'],
  ['move.crossVendor', 'MySQL aur MariaDB ke darmiyan move — kuch cheezein (collations, functions) mukhtalif ho sakti hain', 'Moving between MySQL and MariaDB — some things (collations, functions) may differ', 'MySQL اور MariaDB کے درمیان منتقلی — کچھ چیزیں (collations، functions) مختلف ہو سکتی ہیں'],
  ['move.dumpWarn', 'Dump file me asal data hoga: {file}', 'The dump file will contain real data: {file}', 'Dump فائل میں اصل ڈیٹا ہوگا: {file}'],
  ['move.dumpRunning', '{tool} chal raha hai…', 'Running {tool}…', '{tool} چل رہا ہے…'],
  ['move.needSrcCreds', 'Purane server ka user/password chahiye', 'The old server needs a user/password', 'پرانے سرور کا user/password چاہیے'],
  ['move.dumpFailed', 'Dump mukammal nahi hua: {error}', 'Dump did not complete: {error}', 'Dump مکمل نہیں ہوا: {error}'],
  ['move.dumpDone', 'Dump mukammal: {size} ({file})', 'Dump complete: {size} ({file})', 'Dump مکمل: {size} ({file})'],
  ['move.collationFallback', 'Collation {collation} naye server par nahi — sirf charset ke saath bana rahe hain', 'Collation {collation} is not on the new server — creating it with the charset only', 'Collation {collation} نئے سرور پر نہیں — صرف charset کے ساتھ بنا رہے ہیں'],
  ['move.created', 'Naye server par "{db}" ban gaya', 'Created "{db}" on the new server', 'نئے سرور پر "{db}" بن گیا'],
  ['move.collationCompat', 'MariaDB 11.2+ target: purani collations barqarar rakhne ki setting lagayi', 'MariaDB 11.2+ target: applied the setting that keeps the old collations', 'MariaDB 11.2+ target: پرانی collations برقرار رکھنے کی setting لگائی'],
  ['move.importing', '{tool} se import ho raha hai…', 'Importing with {tool}…', '{tool} سے import ہو رہا ہے…'],
  ['move.importFailed', 'Import fail hua: {error}. Adhoora database "{db}" naye server par reh gaya hai; hatana ho to khud chalayein: {dropSql}', 'Import failed: {error}. The incomplete database "{db}" is left on the new server; to remove it, run this yourself: {dropSql}', 'Import ناکام ہوا: {error}۔ ادھورا database "{db}" نئے سرور پر رہ گیا ہے؛ ہٹانا ہو تو خود چلائیں: {dropSql}'],
  ['move.importDone', 'Import mukammal', 'Import complete', 'Import مکمل'],
  ['move.diff', 'Farq: {what} purana {source} naya {target}', 'Difference: {what} old {source} new {target}', 'فرق: {what} پرانا {source} نیا {target}'],
  ['move.countMismatch', 'Ginti barabar nahi ({count} farq) — naya database check karein', 'Counts do not match ({count} differences) — check the new database', 'گنتی برابر نہیں ({count} فرق) — نیا database چیک کریں'],
  ['move.verifyOk', 'Milan theek: {tables} tables, {rows} rows, {views} views, {routines} routines, {triggers} triggers', 'Verify OK: {tables} tables, {rows} rows, {views} views, {routines} routines, {triggers} triggers', 'موازنہ (verify) ٹھیک: {tables} tables، {rows} rows، {views} views، {routines} routines، {triggers} triggers'],
  ['move.projectLinked', 'Project "{name}" ab "{label}" istemal karega (.env khud nahi badla — button se badlein)', 'Project "{name}" now uses "{label}" (.env was not changed — change it with the button)', 'پروجیکٹ "{name}" اب "{label}" استعمال کرے گا (.env خود نہیں بدلا — بٹن سے بدلیں)'],

  // ---------------------------------------------------------------------------------------- runtimes scan
  ['rt.iniCopyFailed', 'php.ini ki copy nahi ban saki: {message}', 'Could not create the php.ini copy: {message}', 'php.ini کی کاپی نہیں بن سکی: {message}'],
  ['rt.phpNoAnswer', 'PHP ne jawab nahi diya', 'PHP did not respond', 'PHP نے جواب نہیں دیا'],
  ['rt.noPhpForComposer', 'Composer check karne ke liye koi chalta hua PHP nahi mila', 'No working PHP found to check Composer', 'Composer چیک کرنے کے لیے کوئی چلتا ہوا PHP نہیں ملا'],
  ['rt.scanStart', '{php} php.exe, {composer} composer phar, {db} DB bin folders mile — check kar rahe hain', 'Found {php} php.exe, {composer} composer phar, {db} DB bin folders — checking', '{php} php.exe، {composer} composer phar، {db} DB bin فولڈر ملے — check کر رہے ہیں'],
  ['rt.phpOkRelocated', 'PHP {version} · {dir} (php.ini ki relocated copy)', 'PHP {version} · {dir} (relocated php.ini copy)', 'PHP {version} · {dir} (php.ini کی relocated کاپی)'],
  ['rt.composerSame', 'Composer {version} · {path} (doosri file jaisi)', 'Composer {version} · {path} (same as another file)', 'Composer {version} · {path} (دوسری فائل جیسی)'],
  ['rt.datadirUnknown', 'datadir nahi pata', 'datadir unknown', 'datadir معلوم نہیں'],
  ['rt.clientOnly', 'sirf client tools', 'client tools only', 'صرف client tools'],

  // ---------------------------------------------------------------------------------------- process helper (procs)
  ['ps.helperStartFailed', 'PowerShell helper start nahi hua', 'The PowerShell helper did not start', 'PowerShell helper شروع نہیں ہوا'],
  ['ps.helperExited', 'PowerShell helper band ho gaya', 'The PowerShell helper exited', 'PowerShell helper بند ہو گیا'],
  ['ps.helperBadReply', 'PowerShell helper ka jawab samajh nahi aaya', 'Could not understand the PowerShell helper reply', 'PowerShell helper کا جواب سمجھ نہیں آیا'],
  ['ps.noReply', 'PowerShell ka jawab nahi mila', 'No reply from PowerShell', 'PowerShell کا جواب نہیں ملا'],
  ['ps.startFailed', 'PowerShell start nahi hua', 'PowerShell did not start', 'PowerShell شروع نہیں ہوا'],
  ['ps.helperTimeout', 'PowerShell helper ne waqt par jawab nahi diya', 'The PowerShell helper did not reply in time', 'PowerShell helper نے وقت پر جواب نہیں دیا'],
  ['ps.panelStopping', 'panel band ho raha hai', 'the panel is shutting down', 'panel بند ہو رہا ہے'],
  ['ps.noProcessList', 'process list nahi mili', 'could not get the process list', 'process list نہیں ملی'],
  ['ps.netstatFailed', 'netstat nahi chala: {message}', 'netstat failed: {message}', 'netstat نہیں چلا: {message}'],
  ['ps.spawnFailedLog', 'PHP Station: start nahi hua: {message}', 'PHP Station: failed to start: {message}', 'PHP Station: شروع نہیں ہوا: {message}'],
  ['ps.eventNotSet', 'event set nahi hua', 'the event was not set', 'event set نہیں ہوا'],

  // ---------------------------------------------------------------------------------------- v1.1: server / about
  ['err.pickFileKind', 'Sirf kind "sql" chalta hai', 'Only kind "sql" is supported', 'صرف kind "sql" چلتا ہے'],
  ['err.pickFileFailed', 'File chunne wali window nahi khul saki', 'The file picker window could not be opened', 'فائل چننے والی ونڈو نہیں کھل سکی'],
  ['pick.sqlTitle', '.sql file chunein', 'Choose the .sql file', '.sql فائل چنیں'],
  ['err.openUrlNotAllowed', 'Ye link kholne ki ijazat nahi', 'Opening this link is not allowed', 'یہ لنک کھولنے کی اجازت نہیں'],
  ['label.sqlFile', '.sql file', '.sql file', '.sql فائل'],
  ['job.dbProvision', 'Database "{db}" tayyar: {label}', 'Database "{db}" setup: {label}', 'Database "{db}" کی تیاری: {label}'],
  ['job.setup', 'Setup: {name}', 'Setup: {name}', 'سیٹ اپ: {name}'],
  ['job.install', 'Install: {kind} {version}', 'Install: {kind} {version}', 'انسٹال: {kind} {version}'],
  ['job.installBatch', 'Setup Wizard install: {list}', 'Setup Wizard install: {list}', 'Setup Wizard انسٹال: {list}'],
  ['inst.batchEmpty', 'Kam az kam aik cheez chunein', 'Choose at least one item', 'کم از کم ایک چیز چنیں'],
  ['inst.batchTooMany', 'Aik dafa me zyada se zyada {max} cheezein', 'At most {max} items at once', 'ایک دفعہ میں زیادہ سے زیادہ {max} چیزیں'],
  ['inst.batchNothing', 'Chuni hui sab cheezein pehle se install hain', 'Everything chosen is already installed', 'چنی ہوئی سب چیزیں پہلے سے انسٹال ہیں'],
  ['inst.batchItemStart', 'shuru', 'starting', 'شروع'],
  ['inst.batchItemOk', 'mukammal', 'done', 'مکمل'],
  ['inst.batchItemFailed', 'nahi hua: {message} (agli cheez jari hai)', 'failed: {message} (continuing with the next item)', 'نہیں ہوا: {message} (اگلی چیز جاری ہے)'],
  ['inst.batchAllFailed', 'Koi cheez install nahi hui ({n} nakam)', 'Nothing was installed ({n} failed)', 'کوئی چیز انسٹال نہیں ہوئی ({n} ناکام)'],
  ['inst.batchSummary', 'Khulasa: {ok} install hue, {failed} nakam', 'Summary: {ok} installed, {failed} failed', 'خلاصہ: {ok} انسٹال ہوئے، {failed} ناکام'],
  ['wiz.reasonProject', 'Project "{name}" (PHP {need}, Laravel {laravel})', 'Project "{name}" (PHP {need}, Laravel {laravel})', 'پروجیکٹ "{name}" (PHP {need}، Laravel {laravel})'],
  ['wiz.reasonNoPhp', 'Is computer par koi PHP nahi — naya stable version', 'No PHP on this computer — the newest stable version', 'اس کمپیوٹر پر کوئی PHP نہیں — نیا stable version'],
  ['wiz.reasonNoDb', 'Koi MariaDB/MySQL server nahi — LTS version', 'No MariaDB/MySQL server — an LTS version', 'کوئی MariaDB/MySQL سرور نہیں — LTS version'],
  ['wiz.reasonNoComposer', 'Composer nahi mila', 'Composer not found', 'Composer نہیں ملا'],
  ['wiz.reasonOldPhp', 'Purana PHP (7.2.5 se kam) sirf Composer 2.2 LTS chala sakta hai', 'Old PHP (below 7.2.5) can only run Composer 2.2 LTS', 'پرانا PHP (7.2.5 سے کم) صرف Composer 2.2 LTS چلا سکتا ہے'],

  // ---------------------------------------------------------------------------------------- v1.1: port asked once / database missing
  ['err.portConfirm', 'Ye project kis port par chalayein? (sirf pehli dafa poocha jata hai)', 'Which port should this project run on? (asked only before the first run)', 'یہ پروجیکٹ کس port پر چلائیں؟ (صرف پہلی بار پوچھا جاتا ہے)'],
  ['err.portTakenBy', 'Port {port} project "{name}" ka hai — doosra port chunein', 'Port {port} belongs to project "{name}" — choose another port', 'Port {port} پروجیکٹ "{name}" کا ہے — دوسرا port چنیں'],
  ['err.dbMissing', 'Database "{db}" {label} par nahi hai', 'Database "{db}" is not on {label}', 'Database "{db}" {label} پر نہیں ہے'],
  ['warn.dbCheckSkipped', 'Database check nahi ho saka ({message}) — project phir bhi chala diya', 'The database could not be checked ({message}) — the project was started anyway', 'Database چیک نہیں ہو سکا ({message}) — پروجیکٹ پھر بھی چلا دیا'],

  // ---------------------------------------------------------------------------------------- v1.1: db-provision
  ['prov.badMode', 'mode sirf move, import ya empty ho sakta hai', 'mode can only be move, import or empty', 'mode صرف move، import یا empty ہو سکتا ہے'],
  ['prov.noServer', 'Is project ka DB server nahi chuna — pehle DB server chunein', 'No DB server chosen for this project — choose a DB server first', 'اس پروجیکٹ کا DB سرور نہیں چنا — پہلے DB سرور چنیں'],
  ['prov.noDbName', '.env me DB_DATABASE nahi likha', '.env has no DB_DATABASE', '.env میں DB_DATABASE نہیں لکھا'],
  ['prov.chooseFrom', 'Purana server chunein', 'Choose the old server', 'پرانا سرور چنیں'],
  ['prov.sameServer', 'Purana aur naya server aik hi hai', 'The old and the new server are the same', 'پرانا اور نیا سرور ایک ہی ہے'],
  ['prov.notSql', 'Sirf .sql file import ho sakti hai', 'Only a .sql file can be imported', 'صرف .sql فائل import ہو سکتی ہے'],
  ['prov.serverNotRunning', 'DB server "{label}" chal nahi raha — pehle start karein', 'DB server "{label}" is not running — start it first', 'DB سرور "{label}" نہیں چل رہا — پہلے شروع کریں'],
  ['prov.exists', '"{db}" {label} par pehle se maujood hai — kabhi overwrite nahi hota', '"{db}" already exists on {label} — it is never overwritten', '"{db}" {label} پر پہلے سے موجود ہے — کبھی overwrite نہیں ہوتا'],
  ['prov.sqlSwitchesDb', 'Is .sql file me doosre database ka zikr hai ({names}) — ye "{db}" ke bajaye un me likh sakti hai, is liye import nahi kiya. Sirf aik database ka dump lein (USE / CREATE DATABASE ke baghair).', 'This .sql file refers to other databases ({names}) — it could write into them instead of "{db}", so it was not imported. Use a dump of a single database (without USE / CREATE DATABASE).', 'اس .sql فائل میں دوسرے database کا ذکر ہے ({names}) — یہ "{db}" کے بجائے ان میں لکھ سکتی ہے، اس لیے import نہیں کی۔ صرف ایک database کا dump لیں (USE / CREATE DATABASE کے بغیر)۔'],
  ['prov.sqlChecked', '.sql file check ho gayi (sirf isi database ke liye hai)', 'The .sql file was checked (it only targets this database)', '.sql فائل چیک ہو گئی (صرف اسی database کے لیے ہے)'],
  ['prov.created', '"{db}" {label} par ban gaya (utf8mb4)', 'Created "{db}" on {label} (utf8mb4)', '"{db}" {label} پر بن گیا (utf8mb4)'],
  ['prov.importing', '{tool} se import ho raha hai: {file} ({size})', 'Importing with {tool}: {file} ({size})', '{tool} سے import ہو رہا ہے: {file} ({size})'],
  ['prov.importFailed', 'Import fail hua: {error}. Adhoora database "{db}" reh gaya hai; hatana ho to khud chalayein: {dropSql}', 'Import failed: {error}. The incomplete database "{db}" is left in place; to remove it, run this yourself: {dropSql}', 'Import ناکام ہوا: {error}۔ ادھورا database "{db}" رہ گیا ہے؛ ہٹانا ہو تو خود چلائیں: {dropSql}'],
  ['prov.importDone', 'Import mukammal: {tables} tables ({size})', 'Import complete: {tables} tables ({size})', 'Import مکمل: {tables} tables ({size})'],

  // ---------------------------------------------------------------------------------------- v1.1: environment setup
  ['setup.badActions', 'actions aik list honi chahiye: CREATE_ENV, SET_DB, SET_APP_URL, COMPOSER_INSTALL, GENERATE_KEY', 'actions must be a list of: CREATE_ENV, SET_DB, SET_APP_URL, COMPOSER_INSTALL, GENERATE_KEY', 'actions ایک فہرست ہونی چاہیے: CREATE_ENV، SET_DB، SET_APP_URL، COMPOSER_INSTALL، GENERATE_KEY'],
  ['setup.unknownAction', 'Ye action nahi pehchana: {action}', 'Unknown action: {action}', 'یہ action پہچانا نہیں گیا: {action}'],
  ['setup.needDbServer', 'DB settings ke liye pehle project ka DB server chunein', 'Choose the project\'s DB server first for the DB settings', 'DB کی settings کے لیے پہلے پروجیکٹ کا DB سرور چنیں'],
  ['setup.action.CREATE_ENV', '.env banayein (.env.example se)', 'Create .env (from .env.example)', '.env بنائیں (.env.example سے)'],
  ['setup.action.SET_DB', '.env me DB settings likhein', 'Write the DB settings into .env', '.env میں DB کی settings لکھیں'],
  ['setup.action.SET_APP_URL', 'APP_URL project ke port par', 'APP_URL on the project\'s port', 'APP_URL پروجیکٹ کے port پر'],
  ['setup.action.COMPOSER_INSTALL', 'composer install chalayein', 'Run composer install', 'composer install چلائیں'],
  ['setup.action.GENERATE_KEY', 'APP_KEY banayein (key:generate)', 'Generate APP_KEY (key:generate)', 'APP_KEY بنائیں (key:generate)'],
  ['setup.envExists', '.env pehle se maujood hai — kuch nahi badla (kabhi overwrite nahi hota)', '.env already exists — nothing changed (it is never overwritten)', '.env پہلے سے موجود ہے — کچھ نہیں بدلا (کبھی overwrite نہیں ہوتا)'],
  ['setup.noExample', '.env.example nahi mila', '.env.example not found', '.env.example نہیں ملا'],
  ['setup.envCreated', '.env bana di (.env.example ki copy)', 'Created .env (a copy of .env.example)', '.env بنا دی (.env.example کی کاپی)'],
  ['setup.envKeys', '.env me badla: {keys} (pehle backup bana)', 'Changed in .env: {keys} (a backup was made first)', '.env میں بدلا: {keys} (پہلے backup بنا)'],
  ['setup.nothingToChange', 'Pehle se theek hai — kuch nahi badla', 'Already correct — nothing changed', 'پہلے سے ٹھیک ہے — کچھ نہیں بدلا'],
  ['setup.appUrl', 'APP_URL={url} likh diya (pehle backup bana)', 'Wrote APP_URL={url} (a backup was made first)', 'APP_URL={url} لکھ دیا (پہلے backup بنا)'],
  ['setup.noComposer', 'Koi Composer nahi mila — "Install / Setup" page se Composer install karein', 'No Composer found — install one from the "Install / Setup" page', 'کوئی Composer نہیں ملا — "Install / Setup" صفحے سے Composer انسٹال کریں'],
  ['setup.composerFailed', 'composer install fail hua: {line}', 'composer install failed: {line}', 'composer install ناکام ہوا: {line}'],
  ['setup.composerOk', 'composer install mukammal', 'composer install finished', 'composer install مکمل'],
  ['setup.keyExists', 'APP_KEY pehle se hai — nahi badla', 'APP_KEY is already set — not changed', 'APP_KEY پہلے سے ہے — نہیں بدلا'],
  ['setup.keyNeedsVendor', 'APP_KEY ke liye vendor folder chahiye — pehle "composer install" chalayein', 'APP_KEY needs the vendor folder — run "composer install" first', 'APP_KEY کے لیے vendor فولڈر چاہیے — پہلے "composer install" چلائیں'],
  ['setup.keyFailed', 'key:generate fail hua: {line}', 'key:generate failed: {line}', 'key:generate ناکام ہوا: {line}'],
  ['setup.keyOk', 'APP_KEY ban gaya (pehle backup bana)', 'APP_KEY generated (a backup was made first)', 'APP_KEY بن گیا (پہلے backup بنا)'],
  ['setup.configCleared', 'php artisan config:clear chal gaya (config cache saaf)', 'Ran php artisan config:clear (config cache cleared)', 'php artisan config:clear چل گیا (config cache صاف)'],

  // ---------------------------------------------------------------------------------------- v1.1: installer
  ['inst.urlBad', 'Ye URL nahi chal sakta: {url}', 'This URL is not allowed: {url}', 'یہ URL نہیں چل سکتا: {url}'],
  ['inst.urlNotHttps', 'Sirf https chalta hai: {url}', 'Only https is allowed: {url}', 'صرف https چلتا ہے: {url}'],
  ['inst.hostNotAllowed', 'Server {host} ijazat wali list me nahi — download roka gaya', 'Host {host} is not on the allowed list — download blocked', 'سرور {host} اجازت والی فہرست میں نہیں — download روک دیا گیا'],
  ['inst.netFailed', 'Internet se rabta nahi ho saka: {message}', 'Could not reach the internet: {message}', 'انٹرنیٹ سے رابطہ نہیں ہو سکا: {message}'],
  ['inst.timeout', 'waqt khatam (timeout)', 'timed out', 'وقت ختم (timeout)'],
  ['inst.httpStatus', 'Server ne {status} jawab diya: {url}', 'The server answered {status}: {url}', 'سرور نے {status} جواب دیا: {url}'],
  ['inst.tooManyRedirects', 'Bohat zyada redirects (5 se zyada): {url}', 'Too many redirects (more than 5): {url}', 'بہت زیادہ redirects (5 سے زیادہ): {url}'],
  ['inst.tooBig', 'File had se bari hai: {url}', 'The file is larger than allowed: {url}', 'فائل حد سے بڑی ہے: {url}'],
  ['inst.badJson', 'Jawab samajh nahi aaya (JSON): {url}', 'Could not understand the answer (JSON): {url}', 'جواب سمجھ نہیں آیا (JSON): {url}'],
  ['inst.incomplete', 'Download adhoora raha: {url}', 'The download was incomplete: {url}', 'Download ادھورا رہا: {url}'],
  ['inst.shaMismatch', 'SHA-256 mail nahi khaya — {file} delete kar di, kuch install nahi hua', 'SHA-256 does not match — {file} was deleted, nothing was installed', 'SHA-256 میل نہیں کھایا — {file} ڈیلیٹ کر دی، کچھ انسٹال نہیں ہوا'],
  ['inst.badArchive', 'Zip file theek nahi ({reason})', 'The zip file is not valid ({reason})', 'Zip فائل ٹھیک نہیں ({reason})'],
  ['inst.unsafeArchive', 'Zip me khatarnak raasta hai ({name}) — extract nahi kiya', 'The zip contains an unsafe path ({name}) — not extracted', 'Zip میں خطرناک راستہ ہے ({name}) — extract نہیں کیا'],
  ['inst.badKindVersion', 'kind (php, mariadb, composer) aur version (misal 8.4.1) theek dein', 'Give a valid kind (php, mariadb, composer) and version (e.g. 8.4.1)', 'kind (php، mariadb، composer) اور version (مثال 8.4.1) ٹھیک دیں'],
  ['inst.badKind', 'kind sirf php, mariadb, composer ya phpmyadmin ho sakta hai', 'kind can only be php, mariadb, composer or phpmyadmin', 'kind صرف php، mariadb، composer یا phpmyadmin ہو سکتا ہے'],
  ['pma.missing', 'PHP Station me abhi phpMyAdmin nahi — official download karein ya XAMPP/Laragon wala copy karein', 'PHP Station has no phpMyAdmin yet — download the official one or copy the XAMPP/Laragon one', 'PHP Station میں ابھی phpMyAdmin نہیں — سرکاری download کریں یا XAMPP/Laragon والا copy کریں'],
  ['pma.noPhp', 'phpMyAdmin chalane ke liye mysqli wala PHP 7.2.5+ nahi mila', 'No PHP 7.2.5+ with mysqli found to run phpMyAdmin', 'phpMyAdmin چلانے کے لیے mysqli والا PHP 7.2.5+ نہیں ملا'],
  ['pma.noPort', 'phpMyAdmin ke liye web port range me koi port khali nahi', 'No free port in the web port range for phpMyAdmin', 'phpMyAdmin کے لیے web port رینج میں کوئی port خالی نہیں'],
  ['pma.startFailed', 'phpMyAdmin server start nahi hua — data\\logs\\phpmyadmin.log dekhein', 'The phpMyAdmin server did not start — see data\\logs\\phpmyadmin.log', 'phpMyAdmin سرور شروع نہیں ہوا — data\\logs\\phpmyadmin.log دیکھیں'],
  ['pma.notDetected', 'Ye phpMyAdmin folder pehchana hua nahi', 'This phpMyAdmin folder is not a detected one', 'یہ phpMyAdmin فولڈر پہچانا ہوا نہیں'],
  ['pma.copying', 'Copy ho raha hai: {from} -> {to} (asal folder nahi badalta)', 'Copying {from} -> {to} (the original folder is not changed)', 'Copy ہو رہا ہے: {from} -> {to} (اصل فولڈر نہیں بدلتا)'],
  ['pma.copyFailed', 'Copy nahi ho saka: {message}', 'Copy failed: {message}', 'Copy نہیں ہو سکا: {message}'],
  ['job.pmaCopy', 'phpMyAdmin {version} copy ({stack})', 'Copy phpMyAdmin {version} ({stack})', 'phpMyAdmin {version} کی نقل ({stack})'],
  ['wiz.reasonNoPma', 'Database dekhne ke liye (DB admin)', 'To browse databases (DB admin)', 'Database دیکھنے کے لیے (DB admin)'],
  ['inst.catalogEmpty', 'Official list me koi download nahi mila', 'No download found in the official list', 'سرکاری فہرست میں کوئی download نہیں ملا'],
  ['inst.missingPhp', 'Koi chalta hua PHP nahi mila', 'No working PHP found', 'کوئی چلتا ہوا PHP نہیں ملا'],
  ['inst.missingDb', 'Koi MariaDB/MySQL server nahi mila', 'No MariaDB/MySQL server found', 'کوئی MariaDB/MySQL سرور نہیں ملا'],
  ['inst.missingComposer', 'Composer nahi mila', 'Composer not found', 'Composer نہیں ملا'],
  ['inst.tarFailed', 'tar.exe se extract nahi hua ({message}) — PowerShell se koshish', 'tar.exe could not extract ({message}) — trying PowerShell', 'tar.exe سے extract نہیں ہوا ({message}) — PowerShell سے کوشش'],
  ['inst.extractFailed', 'Extract nahi hua: {message}', 'Extraction failed: {message}', 'Extract نہیں ہوا: {message}'],
  ['inst.noChecksum', 'Official SHA-256 nahi mila — baghair check ke install nahi hota', 'No official SHA-256 found — nothing is installed without the check', 'سرکاری SHA-256 نہیں ملا — چیک کے بغیر انسٹال نہیں ہوتا'],
  ['inst.cacertOk', 'CA certificates (cacert.pem) check ho kar mil gaye: {path}', 'CA certificates (cacert.pem) downloaded and verified: {path}', 'CA certificates (cacert.pem) چیک ہو کر مل گئے: {path}'],
  ['inst.cacertFailed', 'cacert.pem nahi mil saka ({message}) — PHP phir bhi install ho raha hai (https ke liye CA file baad me lagayein)', 'Could not get cacert.pem ({message}) — PHP is installed anyway (set a CA file for https later)', 'cacert.pem نہیں مل سکا ({message}) — PHP پھر بھی انسٹال ہو رہا ہے (https کے لیے CA فائل بعد میں لگائیں)'],
  ['inst.instanceFailed', 'MariaDB install ho gaya lekin DB server nahi bana: {message} — DB Servers page se "+ Naya DB server" banayein', 'MariaDB was installed but the DB server was not created: {message} — create one with "+ New DB server" on the DB Servers page', 'MariaDB انسٹال ہو گیا لیکن DB سرور نہیں بنا: {message} — DB Servers صفحے سے "+ نیا DB سرور" بنائیں'],
  ['inst.notRecognised', 'runtime scan me pehchana nahi gaya', 'not recognised by the runtime scan', 'runtime scan میں پہچانا نہیں گیا'],
  ['inst.noDbPort', 'DB port range me koi port khali nahi', 'No free port in the DB port range', 'DB port رینج میں کوئی port خالی نہیں'],
  ['inst.exists', 'Ye version pehle se install hai: {path} (kabhi overwrite nahi hota)', 'This version is already installed: {path} (it is never overwritten)', 'یہ version پہلے سے انسٹال ہے: {path} (کبھی overwrite نہیں ہوتا)'],
  ['inst.notInCatalog', '{kind} {version} official list me nahi mila', '{kind} {version} is not in the official list', '{kind} {version} سرکاری فہرست میں نہیں ملا'],
  ['inst.source', 'Source: {url} ({size})', 'Source: {url} ({size})', 'ذریعہ: {url} ({size})'],
  ['inst.target', 'Install folder: {path}', 'Install folder: {path}', 'انسٹال فولڈر: {path}'],
  ['inst.shaOk', 'SHA-256 theek hai ({sha}…)', 'SHA-256 verified ({sha}…)', 'SHA-256 درست ہے ({sha}…)'],
  ['inst.extracted', 'Extract ho gaya ({how})', 'Extracted ({how})', 'Extract ہو گیا ({how})'],
  ['inst.phpIni', 'php.ini ban gayi (extensions: {list})', 'php.ini created (extensions: {list})', 'php.ini بن گئی (extensions: {list})'],
  ['inst.installed', 'Install ho gaya: {path}', 'Installed: {path}', 'انسٹال ہو گیا: {path}'],
  ['inst.scanning', 'Runtimes dobara scan ho rahe hain…', 'Rescanning runtimes…', 'Runtimes دوبارہ اسکین ہو رہے ہیں…'],
  ['inst.instanceOk', 'Naya DB server ban gaya (port {port}) — DB Servers page se start karein', 'New DB server created (port {port}) — start it on the DB Servers page', 'نیا DB سرور بن گیا (port {port}) — DB Servers صفحے سے شروع کریں'],
  ['inst.confirmRequired', 'Install se pehle tasdeeq (confirm) zaroori hai', 'Confirmation is required before installing', 'انسٹال سے پہلے تصدیق (confirm) ضروری ہے'],
  ['inst.busy', 'Aik install pehle se chal raha hai — us ke khatam hone ka intezar karein', 'An install is already running — wait for it to finish', 'ایک انسٹال پہلے سے چل رہا ہے — اس کے ختم ہونے کا انتظار کریں'],
];

const CATALOG = { roman: {}, en: {}, ur: {} };
for (const [key, roman, en, ur] of ROWS) {
  CATALOG.roman[key] = roman;
  CATALOG.en[key] = en;
  CATALOG.ur[key] = ur;
}

let current = DEFAULT_LANG;

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function isLang(lang) {
  return typeof lang === 'string' && LANGS.includes(lang);
}

/** Sets the language for tr(); unknown values fall back to the default. Returns the active language. */
function setLang(lang) {
  current = isLang(lang) ? lang : DEFAULT_LANG;
  return current;
}

function getLang() {
  return current;
}

/** Replaces {name} with params.name (one pass, so values are never re-scanned). Unknown names stay as-is. */
function format(text, params) {
  if (!params || typeof params !== 'object') return text;
  return text.replace(/\{(\w+)\}/g, (m, k) => (hasOwn(params, k) ? String(params[k]) : m));
}

/** Text for key in a given language -> roman -> the key itself. */
function trIn(lang, key, params) {
  const table = isLang(lang) ? CATALOG[lang] : CATALOG[DEFAULT_LANG];
  let text = hasOwn(table, key) ? table[key] : undefined;
  if (typeof text !== 'string') text = hasOwn(CATALOG.roman, key) ? CATALOG.roman[key] : undefined;
  if (typeof text !== 'string') text = String(key);
  return format(text, params);
}

/** Text for key in the current language. */
function tr(key, params) {
  return trIn(current, key, params);
}

/** Language for console output (CLI, terminal.cmd): English for 'en', otherwise Roman Urdu. */
function consoleLang(lang = current) {
  return lang === 'en' ? 'en' : 'roman';
}

function trConsole(key, params) {
  return trIn(consoleLang(), key, params);
}

/** Sorted, de-duplicated placeholder names of a text (used by the tests). */
function placeholders(text) {
  const out = new Set();
  String(text).replace(/\{(\w+)\}/g, (m, k) => { out.add(k); return m; });
  return [...out].sort();
}

module.exports = {
  LANGS,
  DEFAULT_LANG,
  CATALOG,
  tr,
  trIn,
  trConsole,
  consoleLang,
  setLang,
  getLang,
  isLang,
  format,
  placeholders,
};
