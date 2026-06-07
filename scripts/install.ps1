[CmdletBinding()]
param(
  [string]$Repo = $(if ($env:DEXYD_REPO_URL) { $env:DEXYD_REPO_URL } else { 'https://github.com/DrB0rk/dexyd.git' }),
  [string]$Branch = $(if ($env:DEXYD_BRANCH) { $env:DEXYD_BRANCH } else { 'main' }),
  [string]$Dir = $(if ($env:DEXYD_INSTALL_DIR) { $env:DEXYD_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA 'Dexyd' }),
  [switch]$UseCurrent,
  [switch]$NoPath,
  [switch]$Clean,
  [switch]$Yes
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Write-Ok([string]$Message) { Write-Host "✓ $Message" }
function Write-Warn([string]$Message) { Write-Warning $Message }
function Fail([string]$Message) { throw $Message }
function Has([string]$Command) { $null -ne (Get-Command $Command -ErrorAction SilentlyContinue) }

function Resolve-FullPath([string]$Path) {
  $expanded = [Environment]::ExpandEnvironmentVariables($Path)
  $expanded = $expanded.Replace('~', $HOME)
  return [System.IO.Path]::GetFullPath($expanded)
}

function Get-PythonCommand {
  if (Has py) { return @('py', '-3') }
  if (Has python) { return @('python') }
  if (Has python3) { return @('python3') }
  return $null
}

function Invoke-Checked([string]$File, [string[]]$Args, [string]$WorkingDirectory = $PWD.Path) {
  Push-Location $WorkingDirectory
  try {
    & $File @Args
    if ($LASTEXITCODE -ne 0) { Fail "$File $($Args -join ' ') failed with exit $LASTEXITCODE" }
  } finally {
    Pop-Location
  }
}

function Python-Args($Py) {
  if ($Py.Length -le 1) { return @() }
  return $Py[1..($Py.Length - 1)]
}

function Test-NodeMajor {
  if (-not (Has node)) { return 0 }
  $major = & node -p "Number(process.versions.node.split('.')[0])" 2>$null
  if ($LASTEXITCODE -ne 0) { return 0 }
  return [int]$major
}

function Check-Dependencies {
  $missing = @()
  foreach ($cmd in @('git', 'node', 'npm')) {
    if (-not (Has $cmd)) { $missing += $cmd }
  }
  if (-not (Get-PythonCommand)) { $missing += 'python' }
  if ($missing.Count -gt 0) {
    Fail "Missing required tools: $($missing -join ', '). Install Git, Node.js 20+, npm, and Python 3, then rerun."
  }
  $major = Test-NodeMajor
  if ($major -lt 20) { Fail "Node.js 20+ is required. Current: $(& node --version)" }
  Write-Ok 'Core dependencies ready'
}

function Remove-InstalledDexyd([string]$InstallDir) {
  $binDir = Join-Path $InstallDir 'bin'
  foreach ($name in @('dexyd.cmd', 'dexyd.ps1')) {
    $shim = Join-Path $binDir $name
    if (Test-Path $shim) { Remove-Item $shim -Force }
  }
  if (Test-Path $InstallDir) { Remove-Item $InstallDir -Recurse -Force }
  Write-Ok "Removed installed Dexyd app directory: $InstallDir"
}

function Copy-CurrentCheckout([string]$Source, [string]$Target) {
  if (-not (Test-Path (Join-Path $Source 'package.json')) -or -not (Test-Path (Join-Path $Source 'src'))) {
    Fail '-UseCurrent must be run from the Dexyd repository root.'
  }
  New-Item -ItemType Directory -Force -Path $Target | Out-Null
  $preserve = @('.dexyd', 'dexyd.config.yaml')
  Get-ChildItem -LiteralPath $Target -Force | Where-Object { $preserve -notcontains $_.Name } | Remove-Item -Recurse -Force
  $exclude = @('.git', '.github', '.omx', '.dexyd', 'dev', 'mobile', 'node_modules', 'test', 'dist', 'coverage', '.gradle', 'build', '.cache', 'tmp', 'temp', 'dexyd.config.yaml')
  Get-ChildItem -LiteralPath $Source -Force | Where-Object { $exclude -notcontains $_.Name } | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $Target $_.Name) -Recurse -Force
  }
}

function Resolve-Source([string]$InstallDir) {
  if ($UseCurrent) {
    Write-Host "Deploying current checkout into $InstallDir"
    Copy-CurrentCheckout -Source (Get-Location).Path -Target $InstallDir
    return $InstallDir
  }
  if (Test-Path (Join-Path $InstallDir '.git')) {
    Write-Host "Updating Dexyd in $InstallDir"
    Invoke-Checked git @('-C', $InstallDir, 'remote', 'set-url', 'origin', $Repo)
    Invoke-Checked git @('-C', $InstallDir, 'fetch', '--prune', '--tags', 'origin')
    Invoke-Checked git @('-C', $InstallDir, 'checkout', $Branch)
    Invoke-Checked git @('-C', $InstallDir, 'pull', '--ff-only', 'origin', $Branch)
  } else {
    if (Test-Path $InstallDir) { Remove-Item $InstallDir -Recurse -Force }
    Write-Host "Cloning Dexyd into $InstallDir"
    Invoke-Checked git @('clone', '--branch', $Branch, $Repo, $InstallDir)
  }
  return $InstallDir
}

function New-SigningKey {
  $bytes = New-Object byte[] 48
  [System.Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
  return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+','-').Replace('/','_')
}

function Update-Config([string]$Root) {
  $config = Join-Path $Root 'dexyd.config.yaml'
  $example = Join-Path $Root 'dexyd.config.example.yaml'
  if (-not (Test-Path $config)) {
    Copy-Item $example $config
    Write-Ok "Created $config"
  }
  $workspace = $HOME.Replace('\', '/')
  $key = New-SigningKey
  $py = Get-PythonCommand
  $code = @'
from pathlib import Path
import re, sys
path = Path(sys.argv[1])
workspace = sys.argv[2]
key = sys.argv[3]
s = path.read_text(encoding='utf-8')

def replace_or_insert(section, key_name, value):
    global s
    pattern = rf'(?ms)^({re.escape(section)}:\n)(.*?)(?=^[A-Za-z_][A-Za-z0-9_]*:|\Z)'
    m = re.search(pattern, s)
    rendered = f'{key_name}: {value}'
    if not m:
        s += f'\n{section}:\n  {rendered}\n'
        return
    block = m.group(2)
    key_pattern = rf'(?m)^(\s*){re.escape(key_name)}:\s*.*$'
    if re.search(key_pattern, block):
        block = re.sub(key_pattern, lambda km: f'{km.group(1)}{rendered}', block, count=1)
    else:
        block = block.rstrip() + f'\n  {rendered}\n'
    s = s[:m.start(2)] + block + s[m.end(2):]

def current_scalar(key_name):
    m = re.search(rf'(?m)^\s*{re.escape(key_name)}:\s*([^\n#]+)', s)
    return (m.group(1).strip().strip('"\'') if m else '')

replace_or_insert('server', 'host', '0.0.0.0')
replace_or_insert('server', 'publicBaseUrl', '""')
replace_or_insert('codex', 'workspaceRoot', repr(workspace).replace("'", '"'))
replace_or_insert('codex', 'permissionMode', 'bypass')
if current_scalar('signingKey') in {'', 'change-this-in-production-min-16-chars', 'dexyd-dev-change-me', 'test-signing-key-value'}:
    replace_or_insert('auth', 'signingKey', key)
path.write_text(s, encoding='utf-8')
'@
  $tmp = New-TemporaryFile
  Set-Content -Path $tmp -Value $code -Encoding UTF8
  Invoke-Checked $py[0] ((Python-Args $py) + @($tmp, $config, $workspace, $key))
  Remove-Item $tmp -Force
  Write-Ok "Configured $config"
}

function Install-Bridge([string]$Root) {
  if (Test-Path (Join-Path $Root 'package-lock.json')) {
    Invoke-Checked npm @('ci', '--no-audit', '--fund=false') $Root
  } else {
    Invoke-Checked npm @('install', '--no-audit', '--fund=false') $Root
  }
  Invoke-Checked npm @('run', 'build') $Root
  Invoke-Checked npm @('prune', '--omit=dev', '--no-audit', '--fund=false') $Root
  Write-Ok 'Bridge built and runtime dependencies pruned'
}

function Install-Tui([string]$Root) {
  $py = Get-PythonCommand
  $venv = Join-Path $Root '.dexyd\.venv-tui'
  $venvPython = Join-Path $venv 'Scripts\python.exe'
  if (-not (Test-Path $venvPython)) {
    Invoke-Checked $py[0] ((Python-Args $py) + @('-m', 'venv', $venv))
  }
  Invoke-Checked $venvPython @('-m', 'pip', 'install', '--upgrade', 'pip')
  Invoke-Checked $venvPython @('-m', 'pip', 'install', '-r', (Join-Path $Root 'tui\requirements.txt'))
  Set-Content -Path (Join-Path $venv '.deps-installed') -Value 'ok'
  Write-Ok 'TUI dependencies installed'
}

function Install-Command([string]$Root) {
  $bin = Join-Path $Root 'bin'
  $cmd = Join-Path $bin 'dexyd.cmd'
  $ps1 = Join-Path $bin 'dexyd.ps1'
  if (-not (Test-Path $cmd)) {
    Set-Content -Path $cmd -Value "@echo off`r`nnode `"%~dp0dexyd.mjs`" %*`r`n" -Encoding ASCII
  }
  if (-not (Test-Path $ps1)) {
    Set-Content -Path $ps1 -Value "`$ScriptDir = Split-Path -Parent `$MyInvocation.MyCommand.Path`n& node (Join-Path `$ScriptDir 'dexyd.mjs') @args`nexit `$LASTEXITCODE`n" -Encoding UTF8
  }
  if (-not $NoPath) {
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $parts = @($userPath -split ';' | Where-Object { $_ })
    if ($parts -notcontains $bin) {
      [Environment]::SetEnvironmentVariable('Path', (($parts + $bin) -join ';'), 'User')
      Write-Warn "Added $bin to your user PATH. Open a new terminal for 'dexyd' to resolve."
    }
  }
  Write-Ok "Installed command: $cmd"
}

$InstallDir = Resolve-FullPath $Dir
Write-Host 'Dexyd Windows installer'
Write-Host "Repository: $Repo"
Write-Host "Branch:     $Branch"
Write-Host "Install to: $InstallDir"

if ($Clean) {
  Remove-InstalledDexyd $InstallDir
  exit 0
}

Check-Dependencies
$root = Resolve-Source $InstallDir
foreach ($required in @('package.json', 'src\index.ts', 'tui\requirements.txt', 'bin\dexyd.mjs', 'dexyd.config.example.yaml')) {
  if (-not (Test-Path (Join-Path $root $required))) { Fail "Installed tree missing $required" }
}
Update-Config $root
Install-Bridge $root
Install-Tui $root
Install-Command $root

Write-Host ''
Write-Host 'Dexyd installed for Windows'
Write-Host "  $(Join-Path $root 'bin\dexyd.cmd') --tui"
Write-Host "  $(Join-Path $root 'bin\dexyd.cmd')"
Write-Host 'Open a new terminal if PATH was updated.'
