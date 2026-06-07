#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const isWindows = process.platform === 'win32';
const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(rootDir);

if (!process.env.DEXYD_CONFIG && existsSync(join(rootDir, 'dexyd.config.yaml'))) {
  process.env.DEXYD_CONFIG = join(rootDir, 'dexyd.config.yaml');
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', shell: false, ...options });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  process.exit(result.status ?? 0);
}

function probe(command, args = ['--version']) {
  const result = spawnSync(command, args, { stdio: 'ignore', shell: false });
  return result.status === 0;
}

function pythonLauncher() {
  if (isWindows && probe('py', ['-3', '--version'])) return ['py', ['-3']];
  for (const candidate of isWindows ? ['python', 'python3'] : ['python3', 'python']) {
    if (probe(candidate, ['--version'])) return [candidate, []];
  }
  return null;
}

function venvPython(venvDir) {
  return isWindows ? join(venvDir, 'Scripts', 'python.exe') : join(venvDir, 'bin', 'python');
}

function runTui(args) {
  const venvDir = join(rootDir, '.dexyd', '.venv-tui');
  const reqFile = join(rootDir, 'tui', 'requirements.txt');
  const appFile = join(rootDir, 'tui', 'dexyd_tui.py');
  const py = pythonLauncher();
  if (!py) {
    console.error('Python 3 is required to run the Dexyd TUI.');
    process.exit(1);
  }
  const [python, pythonArgs] = py;
  const venvPy = venvPython(venvDir);
  if (!existsSync(venvPy)) {
    console.log(`==> Creating TUI virtualenv at ${venvDir}`);
    mkdirSync(dirname(venvDir), { recursive: true });
    const created = spawnSync(python, [...pythonArgs, '-m', 'venv', venvDir], { stdio: 'inherit' });
    if (created.status !== 0) process.exit(created.status ?? 1);
  }
  const marker = join(venvDir, '.deps-installed');
  const depsStale = !existsSync(marker) || statSync(reqFile).mtimeMs > statSync(marker).mtimeMs;
  if (depsStale) {
    console.log('==> Installing/updating TUI dependencies');
    spawnSync(venvPy, ['-m', 'pip', 'install', '--upgrade', 'pip'], { stdio: 'inherit', env: pipEnv() });
    const installed = spawnSync(venvPy, ['-m', 'pip', 'install', '-r', reqFile], { stdio: 'inherit', env: pipEnv() });
    if (installed.status !== 0) process.exit(installed.status ?? 1);
    spawnSync(venvPy, ['-c', `from pathlib import Path; Path(${JSON.stringify(marker)}).write_text('ok')`], { stdio: 'ignore' });
  }
  console.log('==> Launching Dexyd TUI');
  run(venvPy, [appFile, ...args]);
}

function pipEnv() {
  return { ...process.env, PIP_DISABLE_PIP_VERSION_CHECK: '1', PIP_NO_CACHE_DIR: '1' };
}

function runInstall(args) {
  if (isWindows) {
    const ps = existsSync(join(rootDir, 'scripts', 'install.ps1')) ? join(rootDir, 'scripts', 'install.ps1') : null;
    if (!ps) {
      console.error('Windows installer is missing: scripts/install.ps1');
      process.exit(1);
    }
    run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps, '-UseCurrent', ...toPowerShellArgs(args)]);
  }
  run('bash', [join(rootDir, 'scripts', 'install.sh'), '--use-current', ...args]);
}

function toPowerShellArgs(args) {
  const mapped = [];
  const flagMap = new Map([
    ['--repo', '-Repo'],
    ['--branch', '-Branch'],
    ['--dir', '-Dir'],
    ['--use-current', '-UseCurrent'],
    ['--no-path', '-NoPath'],
    ['--clean', '-Clean'],
    ['--yes', '-Yes'],
    ['-y', '-Yes'],
  ]);
  for (const arg of args) mapped.push(flagMap.get(arg) || arg);
  return mapped;
}

function printVersion() {
  const result = spawnSync(process.execPath, ['-e', "const p=require('./package.json'); console.log(p.version || '0.0.0')"], {
    cwd: rootDir,
    encoding: 'utf8',
  });
  process.stdout.write(result.stdout || '0.0.0\n');
}

const [command, ...rest] = process.argv.slice(2);
switch (command || '') {
  case '--tui':
  case 'tui':
    runTui(rest);
    break;
  case '--install':
  case 'install':
    runInstall(rest);
    break;
  case '--version':
  case '-V':
  case 'version':
    printVersion();
    break;
  case '--help':
  case '-h':
  case 'help':
    console.log(`dexyd commands:
  dexyd --tui       open the bridge TUI
  dexyd --install   run the installer against this checkout
  dexyd --version   print the installed bridge/TUI version
  dexyd             start the built bridge (build first if needed)`);
    break;
  default:
    if (!existsSync(join(rootDir, 'dist', 'index.js'))) {
      if (existsSync(join(rootDir, 'node_modules', '.bin', isWindows ? 'tsc.cmd' : 'tsc'))) {
        const built = spawnSync(isWindows ? 'npm.cmd' : 'npm', ['run', 'build'], { stdio: 'inherit', cwd: rootDir });
        if (built.status !== 0) process.exit(built.status ?? 1);
      } else {
        console.error('Dexyd bridge build is missing. Rerun the installer to rebuild the application.');
        process.exit(1);
      }
    }
    run(process.execPath, ['--enable-source-maps', join(rootDir, 'dist', 'index.js'), ...(command ? [command, ...rest] : rest)], { cwd: rootDir });
}
