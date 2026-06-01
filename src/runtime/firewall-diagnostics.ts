import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

type LoggerLike = {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  debug: (obj: unknown, msg?: string) => void;
};

export async function diagnoseFirewall(input: { host: string; port: number; logger: LoggerLike }): Promise<void> {
  if (process.platform !== 'linux') {
    input.logger.debug({ platform: process.platform }, 'firewall diagnostic skipped on non-linux platform');
    return;
  }

  if (!isLanReachableBind(input.host)) {
    input.logger.info(
      { host: input.host, port: input.port },
      'bridge is not bound to a LAN-facing address; firewall opening is not needed for LAN'
    );
    return;
  }

  const [ufw, firewalld] = await Promise.all([checkUfw(input.port), checkFirewalld(input.port)]);

  if (ufw.installed && ufw.active) {
    if (ufw.allowed) {
      input.logger.info({ firewall: 'ufw', port: input.port }, 'firewall appears to allow dexyd bridge port');
    } else {
      input.logger.warn(
        {
          firewall: 'ufw',
          port: input.port,
          fix: `sudo ufw allow ${input.port}/tcp comment dexyd`,
          manual: `sudo ufw allow ${input.port}/tcp comment dexyd`
        },
        'ufw is active and dexyd bridge port does not appear to be allowed'
      );
    }
    return;
  }

  if (firewalld.installed && firewalld.running) {
    if (firewalld.allowed) {
      input.logger.info({ firewall: 'firewalld', port: input.port }, 'firewall appears to allow dexyd bridge port');
    } else {
      input.logger.warn(
        {
          firewall: 'firewalld',
          port: input.port,
          fix: `sudo firewall-cmd --add-port=${input.port}/tcp --permanent && sudo firewall-cmd --reload`,
          manual: `sudo firewall-cmd --add-port=${input.port}/tcp --permanent && sudo firewall-cmd --reload`
        },
        'firewalld is running and dexyd bridge port does not appear to be allowed'
      );
    }
    return;
  }

  const nftInstalled = await commandExists('nft');
  const iptablesInstalled = await commandExists('iptables');

  if (nftInstalled || iptablesInstalled) {
    input.logger.warn(
      {
        port: input.port,
        fix: `open TCP ${input.port} with your firewall manager`,
        note: 'No active ufw/firewalld frontend was detected; nftables/iptables rules may still block LAN clients.'
      },
      'could not conclusively verify firewall state for dexyd bridge port'
    );
    return;
  }

  input.logger.info({ port: input.port }, 'no common Linux firewall frontend detected for dexyd bridge port');
}

function isLanReachableBind(host: string): boolean {
  return host === '0.0.0.0' || host === '::' || !host.startsWith('127.');
}

async function checkUfw(port: number): Promise<{ installed: boolean; active: boolean; allowed: boolean }> {
  if (!(await commandExists('ufw'))) return { installed: false, active: false, allowed: false };

  const output = await runCapture('ufw', ['status', 'verbose']);
  const statusNeedsRoot = /need to be root|permission denied|password is required/i.test(output);
  const active = /Status:\s+active/i.test(output) || (statusNeedsRoot && (await systemdServiceActive('ufw')));
  const allowed = new RegExp(`(^|\\s)${port}(?:/tcp)?\\s+ALLOW`, 'im').test(output) || new RegExp(`${port}/tcp`, 'i').test(output);
  return { installed: true, active, allowed };
}

async function checkFirewalld(port: number): Promise<{ installed: boolean; running: boolean; allowed: boolean }> {
  if (!(await commandExists('firewall-cmd'))) return { installed: false, running: false, allowed: false };

  const state = await runCapture('firewall-cmd', ['--state']);
  const running = state.trim() === 'running';
  if (!running) return { installed: true, running: false, allowed: false };

  const ports = await runCapture('firewall-cmd', ['--list-ports']);
  return { installed: true, running: true, allowed: ports.split(/\s+/).includes(`${port}/tcp`) };
}

async function commandExists(command: string): Promise<boolean> {
  try {
    await execFileAsync('sh', ['-lc', `command -v ${escapeShell(command)} >/dev/null 2>&1`]);
    return true;
  } catch {
    return false;
  }
}

async function systemdServiceActive(service: string): Promise<boolean> {
  if (!(await commandExists('systemctl'))) return false;

  try {
    const result = await execFileAsync('systemctl', ['is-active', service], { timeout: 3000 });
    return String(result.stdout ?? '').trim() === 'active';
  } catch {
    return false;
  }
}

async function runCapture(command: string, args: string[]): Promise<string> {
  try {
    const result = await execFileAsync(command, args, { timeout: 3000 });
    return `${result.stdout ?? ''}${result.stderr ?? ''}`;
  } catch (error) {
    const partial = error as { stdout?: string; stderr?: string };
    return `${partial.stdout ?? ''}${partial.stderr ?? ''}`;
  }
}

function escapeShell(value: string): string {
  return value.replace(/[^a-zA-Z0-9_./-]/g, '');
}
