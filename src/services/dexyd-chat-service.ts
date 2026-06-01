import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export class DexydChatService {
  private readonly workspacePath: string;

  constructor(private readonly workspaceRoot: string) {
    this.workspacePath = resolve(workspaceRoot, '.dexyd-help');
  }

  ensureWorkspace(): string {
    mkdirSync(this.workspacePath, { recursive: true });
    writeFileSync(
      join(this.workspacePath, 'README.md'),
      dexydHelpContent(),
      { encoding: 'utf8' },
    );
    return this.workspacePath;
  }
}

function dexydHelpContent(): string {
  return `# dexyd help workspace

This workspace is generated for the built-in dexyd help chat. Use it to ask about bridge setup, mobile pairing, TUI usage, troubleshooting, and configuration.

## Core commands

- Start bridge: \`dexyd\` or \`npm run dev\`
- Start TUI: \`dexyd --tui\` or \`npm run tui\`
- LAN firewall example: \`sudo ufw allow 4242/tcp comment dexyd\`

## Bridge

The bridge exposes authenticated REST and WebSocket APIs for sessions, pairing, device trust, chat, files, diffs, projects, usage, and codex-auth account state.

## Mobile app

Pair by scanning a QR from the TUI. The app can switch between paired bridges, create sessions, open Codex/OMX sessions, respond to approvals/questions, view usage limits, and receive in-app notices.

## TUI

The TUI configures the bridge, generates pairing QR codes, manages Cloudflare named tunnels, shows devices/sessions, and can install a user systemd service.

## Security notes

Keep pairing windows short, revoke lost devices, prefer HTTPS for public access, and set a strong auth.signingKey in production.
`;
}
