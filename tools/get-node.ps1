<#
  PHP Station bootstrap: puts a portable Node.js LTS (win-x64 zip) from nodejs.org into
  <PHP Station>\runtimes\node. The zip's SHA-256 is checked against nodejs.org's SHASUMS256.txt
  before it is extracted. No admin rights, no system PATH change, nothing outside the
  PHP Station folder is written.

  Usage (PHP-Station.bat calls it):  powershell -NoProfile -ExecutionPolicy Bypass -File tools\get-node.ps1
  Exit code 0 = node.exe is ready in runtimes\node, 1 = failed.
#>
[CmdletBinding()]
param(
  [string]$ToolDir = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Say([string]$roman, [string]$english) {
  Write-Host "  $roman"
  Write-Host "  ($english)"
}

$runtimes = Join-Path $ToolDir 'runtimes'
$target = Join-Path $runtimes 'node'
$nodeExe = Join-Path $target 'node.exe'

# 1) Already there? Then nothing to do (no network access at all).
if (Test-Path -LiteralPath $nodeExe -PathType Leaf) {
  Say "Node pehle se maujood hai: $nodeExe" "Node is already present: $nodeExe"
  exit 0
}
if (Test-Path -LiteralPath $target) {
  Say "Folder maujood hai magar node.exe nahi: $target - pehle ye folder hata dein." "The folder exists but has no node.exe: $target - remove that folder first."
  exit 1
}

$base = 'https://nodejs.org/dist'
$tmp = $null
$zip = $null
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  # 2) Newest LTS release that has a win-x64 zip (redirects are not followed: nodejs.org only).
  Say 'nodejs.org se Node LTS ki list le rahe hain...' 'Fetching the Node LTS list from nodejs.org...'
  $index = Invoke-RestMethod -Uri "$base/index.json" -UseBasicParsing -MaximumRedirection 0 -TimeoutSec 60
  $lts = @($index | Where-Object {
      ($_.lts -is [string]) -and ($_.version -match '^v\d+\.\d+\.\d+$') -and (@($_.files) -contains 'win-x64-zip')
    } | Sort-Object -Property @{ Expression = { [version]($_.version.Substring(1)) } } -Descending)
  if ($lts.Count -lt 1) { throw 'no LTS release with a win-x64 zip in index.json' }
  $ver = [string]$lts[0].version
  $file = "node-$ver-win-x64.zip"

  # 3) Official checksum.
  $sums = [string](Invoke-RestMethod -Uri "$base/$ver/SHASUMS256.txt" -UseBasicParsing -MaximumRedirection 0 -TimeoutSec 60)
  $expected = $null
  foreach ($line in ($sums -split "`r?`n")) {
    if ($line -match ('^([0-9a-fA-F]{64})\s+' + [regex]::Escape($file) + '\s*$')) { $expected = $Matches[1].ToLowerInvariant(); break }
  }
  if (-not $expected) { throw "no SHA-256 for $file in SHASUMS256.txt" }

  # 4) Download into runtimes\_downloads and verify BEFORE extracting.
  $dl = Join-Path $runtimes '_downloads'
  New-Item -ItemType Directory -Force -Path $dl | Out-Null
  $zip = Join-Path $dl $file
  Say "Download ho raha hai: $base/$ver/$file" "Downloading: $base/$ver/$file"
  Invoke-WebRequest -Uri "$base/$ver/$file" -OutFile $zip -UseBasicParsing -MaximumRedirection 0 -TimeoutSec 900
  $actual = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $expected) {
    Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
    $zip = $null
    throw "SHA-256 mismatch for $file (file deleted)"
  }
  Say 'SHA-256 theek hai.' 'SHA-256 verified.'

  # 5) Extract into a temp folder, then move into place (never over an existing folder).
  $tmp = Join-Path (Join-Path $runtimes '_tmp') ('node-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  $tar = Join-Path $env:SystemRoot 'System32\tar.exe'
  $extracted = $false
  if (Test-Path -LiteralPath $tar -PathType Leaf) {
    & $tar -xf $zip -C $tmp
    if ($LASTEXITCODE -eq 0) { $extracted = $true }
  }
  if (-not $extracted) { Expand-Archive -LiteralPath $zip -DestinationPath $tmp -Force }
  $inner = Join-Path $tmp "node-$ver-win-x64"
  if (-not (Test-Path -LiteralPath (Join-Path $inner 'node.exe') -PathType Leaf)) { throw 'node.exe not found in the zip' }
  if (Test-Path -LiteralPath $target) { throw "$target already exists" }
  Move-Item -LiteralPath $inner -Destination $target
  Say "Node $ver tayyar hai: $nodeExe" "Node $ver is ready: $nodeExe"
  exit 0
}
catch {
  Say "Node download nahi ho saka: $($_.Exception.Message)" "Node could not be downloaded: $($_.Exception.Message)"
  exit 1
}
finally {
  if ($tmp -and (Test-Path -LiteralPath $tmp)) { Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue }
  if ($zip -and (Test-Path -LiteralPath $zip)) { Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue }
}
