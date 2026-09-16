import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT } from './config.js';

export const LABEL = 'dev.carl-github.delta-router';
export const PLIST = path.join(os.homedir(), 'Library/LaunchAgents', `${LABEL}.plist`);
const DOMAIN = `gui/${process.getuid()}`;

function nodeBinary() {
  const shim = path.join(os.homedir(), '.local/share/mise/shims/node');
  return fs.existsSync(shim) ? shim : process.execPath;
}

export function plistContent(cfg) {
  const logs = path.dirname(cfg.logFile);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodeBinary()}</string>
    <string>${path.join(ROOT, 'src/server.js')}</string>
  </array>
  <key>WorkingDirectory</key><string>${ROOT}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${path.join(logs, 'agent.out.log')}</string>
  <key>StandardErrorPath</key><string>${path.join(logs, 'agent.err.log')}</string>
</dict>
</plist>
`;
}

export function isLoaded() {
  return spawnSync('launchctl', ['print', `${DOMAIN}/${LABEL}`], { stdio: 'ignore' }).status === 0;
}

export function start(cfg) {
  fs.mkdirSync(path.dirname(PLIST), { recursive: true });
  fs.writeFileSync(PLIST, plistContent(cfg));
  spawnSync('launchctl', ['bootout', `${DOMAIN}/${LABEL}`], { stdio: 'ignore' });
  const res = spawnSync('launchctl', ['bootstrap', DOMAIN, PLIST], { encoding: 'utf8' });
  return res.status === 0 ? null : res.stderr.trim();
}

export function stop() {
  spawnSync('launchctl', ['bootout', `${DOMAIN}/${LABEL}`], { stdio: 'ignore' });
}

export function restart() {
  const res = spawnSync('launchctl', ['kickstart', '-k', `${DOMAIN}/${LABEL}`], { encoding: 'utf8' });
  return res.status === 0 ? null : res.stderr.trim();
}

export function uninstall() {
  stop();
  fs.rmSync(PLIST, { force: true });
}

/** pid listening on the router port, or null. */
export function listenerPid(port) {
  const res = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' });
  const pid = res.stdout?.trim().split('\n')[0];
  return pid ? Number(pid) : null;
}
