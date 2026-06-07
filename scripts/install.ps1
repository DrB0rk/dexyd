[CmdletBinding()]
param(
  [string]$Repo = $(if ($env:DEXYD_REPO_URL) { $env:DEXYD_REPO_URL } else { 'https://github.com/DrB0rk/dexyd.git' }),
  [string]$Branch = $(if ($env:DEXYD_BRANCH) { $env:DEXYD_BRANCH } else { 'main' }),
  [string]$Dir = $(if ($env:DEXYD_INSTALL_DIR) { $env:DEXYD_INSTALL_DIR } elseif ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'Programs\Dexyd' } else { Join-Path $HOME 'AppData\Local\Programs\Dexyd' }),
  [switch]$UseCurrent,
  [switch]$NoPath,
  [switch]$Clean,
  [switch]$Yes
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$ProgressPreference = 'SilentlyContinue'
try { $PSNativeCommandUseErrorActionPreference = $false } catch {}
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 -bor [Net.SecurityProtocolType]::Tls11 -bor [Net.SecurityProtocolType]::Tls } catch {}


function Write-Ok([string]$Message) { Write-Host "✓ $Message" }
function Write-Note([string]$Message) { Write-Host "- $Message" }
function Write-Warn([string]$Message) { Write-Warning $Message }
function Fail([string]$Message) { throw $Message }
function Resolve-CommandFile([string]$Command) {
  $resolved = Get-Command $Command -CommandType Application,ExternalScript -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($resolved) {
    if ($resolved.Source) { return $resolved.Source }
    if ($resolved.Path) { return $resolved.Path }
  }
  return $null
}
function Has([string]$Command) { $null -ne (Resolve-CommandFile $Command) }

function Resolve-FullPath([string]$Path) {
  if ([string]::IsNullOrWhiteSpace($Path)) { Fail 'Install directory cannot be empty.' }
  $expanded = [Environment]::ExpandEnvironmentVariables($Path)
  if ($expanded -eq '~') { $expanded = $HOME }
  elseif ($expanded.StartsWith('~\') -or $expanded.StartsWith('~/')) { $expanded = Join-Path $HOME $expanded.Substring(2) }
  return [System.IO.Path]::GetFullPath($expanded)
}

function Test-IsPathInside([string]$Path, [string]$Parent) {
  $fullPath = [System.IO.Path]::GetFullPath($Path).TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
  $fullParent = [System.IO.Path]::GetFullPath($Parent).TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
  return $fullPath.StartsWith($fullParent, [System.StringComparison]::OrdinalIgnoreCase)
}

function Invoke-Checked([string]$File, [string[]]$Args, [string]$WorkingDirectory = $PWD.Path) {
  if (-not (Test-Path -LiteralPath $WorkingDirectory)) { New-Item -ItemType Directory -Force -Path $WorkingDirectory | Out-Null }
  $commandPath = Resolve-CommandFile $File
  if (-not $commandPath) { Fail "$File was not found in PATH" }
  Push-Location -LiteralPath $WorkingDirectory
  try {
    Write-Note "+ $File $($Args -join ' ')"
    & $commandPath @Args
    $exit = if ($null -eq $global:LASTEXITCODE) { 0 } else { [int]$global:LASTEXITCODE }
    if ($exit -ne 0) { Fail "$File $($Args -join ' ') failed with exit code $exit" }
  } finally {
    Pop-Location
  }
}

function ConvertTo-ProcessArgument([AllowNull()][string]$Value) {
  if ($null -eq $Value -or $Value.Length -eq 0) { return '""' }
  if ($Value -notmatch '[\s"]') { return $Value }
  $result = '"'
  $slashes = 0
  foreach ($char in $Value.ToCharArray()) {
    if ($char -eq '\') {
      $slashes += 1
    } elseif ($char -eq '"') {
      if ($slashes -gt 0) { $result += ('\' * ($slashes * 2)) }
      $result += '\"'
      $slashes = 0
    } else {
      if ($slashes -gt 0) { $result += ('\' * $slashes) }
      $result += $char
      $slashes = 0
    }
  }
  if ($slashes -gt 0) { $result += ('\' * ($slashes * 2)) }
  $result += '"'
  return $result
}

function Invoke-Capture([string]$File, [string[]]$Args, [string]$WorkingDirectory = $PWD.Path, [int]$TimeoutSeconds = 30) {
  if (-not (Test-Path -LiteralPath $WorkingDirectory)) { New-Item -ItemType Directory -Force -Path $WorkingDirectory | Out-Null }
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $commandPath = Resolve-CommandFile $File
  if (-not $commandPath) { return [pscustomobject]@{ ExitCode = 127; Output = "$File was not found in PATH" } }
  $psi.FileName = $commandPath
  $psi.WorkingDirectory = $WorkingDirectory
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.Arguments = (($Args | ForEach-Object { ConvertTo-ProcessArgument $_ }) -join ' ')

  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $psi
  try {
    [void]$process.Start()
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
      try { $process.Kill() } catch {}
      try { [void]$process.WaitForExit(5000) } catch {}
      return [pscustomobject]@{ ExitCode = 124; Output = "$File $($Args -join ' ') timed out after ${TimeoutSeconds}s" }
    }
    try { [void]$stdoutTask.Wait(5000) } catch {}
    try { [void]$stderrTask.Wait(5000) } catch {}
    $stdout = if ($stdoutTask.IsCompleted) { $stdoutTask.Result } else { '' }
    $stderr = if ($stderrTask.IsCompleted) { $stderrTask.Result } else { '' }
    $output = (($stdout, $stderr) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }) -join [Environment]::NewLine
    return [pscustomobject]@{ ExitCode = [int]$process.ExitCode; Output = $output.Trim() }
  } catch {
    return [pscustomobject]@{ ExitCode = 127; Output = "$File $($Args -join ' ') failed to start: $($_.Exception.Message)" }
  } finally {
    if ($process) { $process.Dispose() }
  }
}

function Test-CommandWorks([string]$File, [string[]]$Args, [int]$TimeoutSeconds = 8) {
  $result = Invoke-Capture $File $Args -TimeoutSeconds $TimeoutSeconds
  return $result.ExitCode -eq 0
}

function Ask-YesNo([string]$Prompt) {
  if ($Yes) { return $true }
  try {
    $answer = Read-Host "$Prompt [y/N]"
    return $answer -match '^(?i:y|yes)$'
  } catch {
    return $false
  }
}

function Get-WindowsPackageManager {
  if (Has winget) { return 'winget' }
  if (Has choco) { return 'choco' }
  return $null
}

function Refresh-PathFromRegistry {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = (($machine, $user, $env:Path) -join ';')
}

function Get-DependencyIssues {
  $issues = @()
  Write-Note 'Checking Git'
  if (-not (Has 'git')) { $issues += 'git' }
  elseif (-not (Test-CommandWorks git @('--version'))) { $issues += 'git' }

  Write-Note 'Checking Node.js'
  if (-not (Has 'node')) { $issues += 'node' }
  else {
    $major = Test-NodeMajor
    if ($major -eq 0) { $issues += 'node' }
    elseif ($major -lt 20) { $issues += "nodejs<20" }
  }

  Write-Note 'Checking npm'
  if (-not (Has 'npm')) { $issues += 'npm' }
  elseif (-not (Test-CommandWorks npm @('--version'))) { $issues += 'npm' }

  Write-Note 'Checking Python'
  if (-not (Get-PythonCommand)) { $issues += 'python' }
  return $issues
}

function Test-BenignWingetOutput([string]$Output) {
  return $Output -match '(?i)(successfully installed|successfully updated|already installed|no applicable update|no newer package versions|package is already installed)'
}

function Invoke-WingetInstall([string]$PackageId) {
  $args = @('install', '--exact', '--silent', '--accept-package-agreements', '--accept-source-agreements', '--id', $PackageId)
  $result = Invoke-Capture winget $args -TimeoutSeconds 900
  if ($result.ExitCode -eq 0 -or (Test-BenignWingetOutput $result.Output)) {
    if ($result.Output) { Write-Note ($result.Output -replace '[\r\n]+', ' ') }
    return $true
  }
  return $result
}

function Install-DependencyPackages([string]$Manager, [string[]]$Issues) {
  $needsGit = $Issues -contains 'git'
  $needsNode = ($Issues -contains 'node') -or ($Issues -contains 'npm') -or (($Issues | Where-Object { $_ -like 'nodejs<20*' }).Count -gt 0)
  $needsPython = $Issues -contains 'python'

  if ($Manager -eq 'winget') {
    if ($needsGit) {
      $gitResult = Invoke-WingetInstall 'Git.Git'
      if ($gitResult -ne $true) { Fail "winget failed to install Git.Git: $($gitResult.Output)" }
    }
    if ($needsNode) {
      $nodeResult = Invoke-WingetInstall 'OpenJS.NodeJS.LTS'
      if ($nodeResult -ne $true) { Fail "winget failed to install OpenJS.NodeJS.LTS: $($nodeResult.Output)" }
    }
    if ($needsPython) {
      $pythonResult = Invoke-WingetInstall 'Python.Python.3.13'
      if ($pythonResult -ne $true) {
        Write-Note 'Python 3.13 winget install did not complete; trying Python 3.12.'
        $pythonFallback = Invoke-WingetInstall 'Python.Python.3.12'
        if ($pythonFallback -ne $true) {
          Write-Warn "Python 3.13 output: $($pythonResult.Output)"
          Fail "winget failed to install Python.Python.3.12: $($pythonFallback.Output)"
        }
      }
    }
    Refresh-PathFromRegistry
    return
  }

  if ($Manager -eq 'choco') {
    $packages = @()
    if ($needsGit) { $packages += 'git' }
    if ($needsNode) { $packages += 'nodejs-lts' }
    if ($needsPython) { $packages += 'python' }
    if ($packages.Count -gt 0) { Invoke-Checked choco (@('install', '-y') + $packages) }
    Refresh-PathFromRegistry
    return
  }

  Fail 'No supported Windows package manager found. Install Git, Node.js 20+, npm, and Python 3 manually, then rerun.'
}

function Get-PythonCommand {
  $probe = 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)'
  if ((Has python) -and (Test-CommandWorks python @('-c', $probe))) { return @('python') }
  if ((Has python3) -and (Test-CommandWorks python3 @('-c', $probe))) { return @('python3') }
  if ((Has py) -and (Test-CommandWorks py @('-3', '-c', $probe))) { return @('py', '-3') }
  return $null
}

function Python-Args($Py) {
  if ($Py.Length -le 1) { return @() }
  return $Py[1..($Py.Length - 1)]
}

function Test-NodeMajor {
  if (-not (Has node)) { return 0 }
  $result = Invoke-Capture node @('-p', 'Number(process.versions.node.split(".")[0])') -TimeoutSeconds 8
  if ($result.ExitCode -ne 0) { return 0 }
  $text = ($result.Output | Out-String).Trim()
  if ($text -notmatch '^\d+') { return 0 }
  return [int]$Matches[0]
}

function Check-Dependencies {
  Write-Note 'Checking Git, Node.js, npm, and Python'
  Refresh-PathFromRegistry
  $issues = @(Get-DependencyIssues)
  if ($issues.Count -gt 0) {
    Write-Warn "Missing or outdated dependencies: $($issues -join ', ')"
    $manager = Get-WindowsPackageManager
    if (-not $manager) {
      Fail 'No supported package manager found. Install Git, Node.js 20+, npm, and Python 3 manually, or install winget/Chocolatey and rerun.'
    }
    if (Ask-YesNo "Install or refresh required dependencies with $manager now?") {
      Install-DependencyPackages $manager $issues
      $issues = @(Get-DependencyIssues)
    } else {
      Fail 'Dependency installation was not approved. Install Git, Node.js 20+, npm, and Python 3 manually, or rerun with -Yes.'
    }
  }

  if ($issues.Count -gt 0) {
    Fail "Still missing or outdated after install attempt: $($issues -join ', '). Open a new terminal or install dependencies manually, then rerun."
  }
  if (-not (Test-CommandWorks git @('--version'))) { Fail 'Git is installed but failed to run. Check your Git for Windows installation and PATH.' }
  $major = Test-NodeMajor
  if ($major -lt 20) { Fail "Node.js 20+ is required. Current: $(& node --version 2>$null)" }
  Write-Ok 'Core dependencies ready'
}

function Backup-DexydData([string]$InstallDir) {
  if (-not (Test-Path -LiteralPath $InstallDir)) { return $null }
  $backupRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("dexyd-install-backup-{0}" -f ([guid]::NewGuid().ToString('N')))
  New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null
  foreach ($name in @('dexyd.config.yaml', '.dexyd')) {
    $src = Join-Path $InstallDir $name
    if (Test-Path -LiteralPath $src) { Copy-Item -LiteralPath $src -Destination (Join-Path $backupRoot $name) -Recurse -Force }
  }
  return $backupRoot
}

function Restore-DexydData([string]$BackupRoot, [string]$InstallDir) {
  if (-not $BackupRoot -or -not (Test-Path -LiteralPath $BackupRoot)) { return }
  New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
  foreach ($name in @('dexyd.config.yaml', '.dexyd')) {
    $src = Join-Path $BackupRoot $name
    if (Test-Path -LiteralPath $src) { Copy-Item -LiteralPath $src -Destination (Join-Path $InstallDir $name) -Recurse -Force }
  }
  Remove-Item -LiteralPath $BackupRoot -Recurse -Force -ErrorAction SilentlyContinue
}

function Remove-InstalledDexyd([string]$InstallDir, [switch]$PreserveData) {
  $backup = if ($PreserveData) { Backup-DexydData $InstallDir } else { $null }
  if (Test-Path -LiteralPath $InstallDir) { Remove-Item -LiteralPath $InstallDir -Recurse -Force }
  if ($PreserveData -and $backup) { Restore-DexydData $backup $InstallDir }
  Write-Ok "Removed installed Dexyd app files: $InstallDir"
}

function Copy-CurrentCheckout([string]$Source, [string]$Target) {
  if (-not (Test-Path (Join-Path $Source 'package.json')) -or -not (Test-Path (Join-Path $Source 'src'))) {
    Fail '-UseCurrent must be run from the Dexyd repository root.'
  }
  New-Item -ItemType Directory -Force -Path $Target | Out-Null
  $preserve = @('.dexyd', 'dexyd.config.yaml')
  Get-ChildItem -LiteralPath $Target -Force -ErrorAction SilentlyContinue | Where-Object { $preserve -notcontains $_.Name } | Remove-Item -Recurse -Force
  $exclude = @('.git', '.github', '.omx', '.dexyd', 'dev', 'mobile', 'node_modules', 'test', 'dist', 'coverage', '.gradle', 'build', '.cache', 'tmp', 'temp', 'dexyd.config.yaml')
  Get-ChildItem -LiteralPath $Source -Force | Where-Object { $exclude -notcontains $_.Name } | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $Target $_.Name) -Recurse -Force
  }
}

function Clone-Dexyd([string]$InstallDir) {
  $parent = Split-Path -Parent $InstallDir
  if ([string]::IsNullOrWhiteSpace($parent)) { Fail "Invalid install directory: $InstallDir" }
  New-Item -ItemType Directory -Force -Path $parent | Out-Null
  $safeCwd = Join-Path ([System.IO.Path]::GetTempPath()) 'dexyd-installer-cwd'
  New-Item -ItemType Directory -Force -Path $safeCwd | Out-Null

  $backup = Backup-DexydData $InstallDir
  if (Test-Path -LiteralPath $InstallDir) { Remove-Item -LiteralPath $InstallDir -Recurse -Force }

  try {
    Write-Host "Cloning Dexyd into $InstallDir"
    $cloneArgs = @('clone', '--branch', $Branch, '--depth', '1', $Repo, $InstallDir)
    $result = Invoke-Capture git $cloneArgs $safeCwd -TimeoutSeconds 300
    if ($result.ExitCode -ne 0) {
      Write-Warn $result.Output
      Write-Warn "Shallow clone failed; retrying full clone."
      if (Test-Path -LiteralPath $InstallDir) { Remove-Item -LiteralPath $InstallDir -Recurse -Force }
      Invoke-Checked git @('clone', '--branch', $Branch, $Repo, $InstallDir) $safeCwd
    }
    Restore-DexydData $backup $InstallDir
  } catch {
    if ($backup -and (Test-Path -LiteralPath $backup)) {
      New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
      Restore-DexydData $backup $InstallDir
    }
    throw
  }
}

function Resolve-Source([string]$InstallDir) {
  $parent = Split-Path -Parent $InstallDir
  if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
  if (Test-IsPathInside (Get-Location).Path $InstallDir) {
    $safeCwd = Join-Path ([System.IO.Path]::GetTempPath()) 'dexyd-installer-cwd'
    New-Item -ItemType Directory -Force -Path $safeCwd | Out-Null
    Set-Location -LiteralPath $safeCwd
  }
  if ($UseCurrent) {
    Write-Host "Deploying current checkout into $InstallDir"
    Copy-CurrentCheckout -Source $script:InitialLocation -Target $InstallDir
    return $InstallDir
  }
  Clone-Dexyd $InstallDir
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
  if (-not (Test-Path -LiteralPath $example)) { Fail "Missing config example: $example" }
  if (-not (Test-Path -LiteralPath $config)) {
    Copy-Item -LiteralPath $example -Destination $config
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
  Remove-Item -LiteralPath $tmp -Force
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
  if ((Test-Path -LiteralPath $venv) -and -not (Test-Path -LiteralPath $venvPython)) {
    Write-Warn "Existing TUI virtualenv is incomplete; recreating $venv"
    Remove-Item -LiteralPath $venv -Recurse -Force
  }
  if (-not (Test-Path -LiteralPath $venvPython)) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $venv) | Out-Null
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
  if (-not (Test-Path -LiteralPath (Join-Path $bin 'dexyd.mjs'))) { Fail 'Portable command launcher missing: bin\dexyd.mjs' }
  Set-Content -Path $cmd -Value "@echo off`r`nnode `"%~dp0dexyd.mjs`" %*`r`n" -Encoding ASCII
  Set-Content -Path $ps1 -Value "`$ScriptDir = Split-Path -Parent `$MyInvocation.MyCommand.Path`n& node (Join-Path `$ScriptDir 'dexyd.mjs') @args`nexit `$LASTEXITCODE`n" -Encoding UTF8
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

function Assert-WindowsHost {
  $isWindowsVariable = Get-Variable -Name IsWindows -ErrorAction SilentlyContinue
  if ($isWindowsVariable -and $isWindowsVariable.Value -eq $false) {
    Fail 'This installer is for Windows. Use scripts/install.sh on Linux/macOS.'
  }
  if ($env:OS -and $env:OS -ne 'Windows_NT') {
    Fail 'This installer is for Windows. Use scripts/install.sh on Linux/macOS.'
  }
}

function Invoke-DexydInstallerMain {
Assert-WindowsHost
$script:InitialLocation = (Get-Location).Path
$InstallDir = Resolve-FullPath $Dir
Write-Host 'Dexyd Windows installer'
Write-Host "Repository: $Repo"
Write-Host "Branch/tag:  $Branch"
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
}

try {
  Invoke-DexydInstallerMain
} catch {
  Write-Host ''
  Write-Host 'Dexyd installer failed:' -ForegroundColor Red
  Write-Host $_.Exception.Message -ForegroundColor Red
  if ($_.ScriptStackTrace) { Write-Host $_.ScriptStackTrace -ForegroundColor DarkGray }
  Write-Host ''
  Write-Host 'If this is a dependency issue, install or repair Git, Node.js 20+, npm, and Python 3.10+, then rerun.' -ForegroundColor Yellow
  Write-Host 'To allow automatic dependency installation, download the script and run it with -Yes.' -ForegroundColor Yellow
  exit 1
}
