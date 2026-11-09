# install.ps1 - one-click installer for dsh-douyin-chat
# ASCII only on purpose: Windows PowerShell 5.1 reads .ps1 as ANSI.
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

function Info($m) { Write-Host "[*] $m" }
function Ok($m)   { Write-Host "[+] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "[!] $m" -ForegroundColor Yellow }
function Fail($m) { Write-Host "[x] $m" -ForegroundColor Red }

Write-Host ''
Write-Host '  dsh-douyin-chat installer' -ForegroundColor Cyan
Write-Host '  Douyin group chat / DM assistant for DSH'
Write-Host ''

# 1) Node.js
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Fail 'Node.js not found. Install Node 22+ first: https://nodejs.org'
  exit 1
}
$ver = (& node -v) -replace '^v', ''
$major = [int]($ver.Split('.')[0])
if ($major -lt 22) { Warn "Node $ver detected; 22+ is recommended." } else { Ok "Node $ver" }

# 2) Chrome / Edge
$browsers = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ }
if (-not $browsers) { Fail 'No Chrome/Edge found. Install one of them first.'; exit 1 }
Ok ("Browser: " + (Split-Path -Leaf (Split-Path -Parent (Split-Path -Parent $browsers[0]))))

# 3) Copy to a stable location
$dest = Join-Path $env:USERPROFILE '.dsh\plugins\dsh-douyin-chat'
if (Test-Path $dest) { Info "Removing previous copy: $dest"; Remove-Item $dest -Recurse -Force }
New-Item -ItemType Directory -Path $dest -Force | Out-Null
Copy-Item (Join-Path $here '*') -Destination $dest -Recurse -Force
Ok "Installed to $dest"

# 4) Try the dsh CLI
$dsh = Get-Command dsh -ErrorAction SilentlyContinue
if ($dsh) {
  Info 'Registering as a DSH plugin via CLI...'
  $done = $false
  $profRoot = Join-Path $env:USERPROFILE '.dsh\profiles'
  $profiles = @('desktop', 'web', 'headless') | Where-Object { Test-Path (Join-Path $profRoot $_) }
  if (-not $profiles) { $profiles = @('desktop') }
  foreach ($prof in $profiles) {
    Info ("trying profile: " + $prof)
    try {
      & dsh plugin add --profile $prof ("link:" + $dest) 2>&1 | ForEach-Object { Write-Host "    $_" }
      if ($LASTEXITCODE -eq 0) { Ok ("Plugin registered to profile: " + $prof); $done = $true; break }
    } catch { Write-Host ("    " + $_.Exception.Message) }
  }
  if (-not $done) { Warn 'CLI could not register (app-managed profile). Add it from the DSH app instead.' }
} else {
  Warn 'dsh CLI not found. If you use the desktop app, add the plugin manually:'
  Write-Host "    Settings -> Plugins -> add local bundle -> $dest"
}

# 5) First run hints
Write-Host ''
Ok 'Done. Next steps:'
Write-Host '  1. Restart DSH'
Write-Host '  2. Open the sidebar item "Douyin chat"'
Write-Host '  3. Click Login, scan the QR code in the browser window'
Write-Host '  4. Turn on "group auto reply" / "DM auto reply" in Settings'
Write-Host ''
Write-Host "Data folder: $env:USERPROFILE\.dsh\fish" -ForegroundColor DarkGray
Write-Host 'Uninstall: delete that folder and remove the plugin in DSH.' -ForegroundColor DarkGray
exit 0
