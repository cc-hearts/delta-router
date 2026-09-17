import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { ROOT, loadConfig } from './config.js';

export const LABEL = 'dev.carl-github.delta-router';
export const PLIST = path.join(os.homedir(), 'Library/LaunchAgents', `${LABEL}.plist`);
const DOMAIN = process.platform === 'darwin' && typeof process.getuid === 'function' ? `gui/${process.getuid()}` : '';

export const PID_FILE = path.join(ROOT, 'logs', 'agent.pid');
export const WIN_STARTUP = process.platform === 'win32'
  ? path.join(
      process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
      'Microsoft',
      'Windows',
      'Start Menu',
      'Programs',
      'Startup',
      `${LABEL}.vbs`,
    )
  : '';

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
  if (process.platform === 'darwin') {
    return spawnSync('launchctl', ['print', `${DOMAIN}/${LABEL}`], { stdio: 'ignore' }).status === 0;
  }
  if (process.platform === 'win32') {
    if (fs.existsSync(WIN_STARTUP)) return true;
    try {
      const cfg = loadConfig();
      return listenerPid(cfg.listen.port) !== null;
    } catch {
      return false;
    }
  }
  return false;
}

export function start(cfg) {
  if (process.platform === 'darwin') {
    fs.mkdirSync(path.dirname(PLIST), { recursive: true });
    fs.writeFileSync(PLIST, plistContent(cfg));
    spawnSync('launchctl', ['bootout', `${DOMAIN}/${LABEL}`], { stdio: 'ignore' });
    const res = spawnSync('launchctl', ['bootstrap', DOMAIN, PLIST], { encoding: 'utf8' });
    return res.status === 0 ? null : res.stderr.trim();
  }

  // Windows / other platforms: spawn detached background process
  try {
    stop();
    const logs = path.dirname(cfg.logFile);
    fs.mkdirSync(logs, { recursive: true });
    const outFd = fs.openSync(path.join(logs, 'agent.out.log'), 'a');
    const errFd = fs.openSync(path.join(logs, 'agent.err.log'), 'a');
    const child = spawn(process.execPath, [path.join(ROOT, 'src/server.js')], {
      cwd: ROOT,
      detached: true,
      stdio: ['ignore', outFd, errFd],
      windowsHide: true,
    });
    child.unref();
    fs.closeSync(outFd);
    fs.closeSync(errFd);
    fs.writeFileSync(PID_FILE, String(child.pid), 'utf8');
    return null;
  } catch (err) {
    return err.message;
  }
}

export function stop() {
  if (process.platform === 'darwin') {
    spawnSync('launchctl', ['bootout', `${DOMAIN}/${LABEL}`], { stdio: 'ignore' });
    return;
  }

  let pid = null;
  if (fs.existsSync(PID_FILE)) {
    try {
      pid = Number(fs.readFileSync(PID_FILE, 'utf8').trim());
      fs.rmSync(PID_FILE, { force: true });
    } catch {}
  }
  if (!pid) {
    try {
      const cfg = loadConfig();
      pid = listenerPid(cfg.listen.port);
    } catch {}
  }
  if (pid) {
    try {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/PID', String(pid), '/F', '/T'], { stdio: 'ignore' });
      } else {
        process.kill(pid, 'SIGTERM');
      }
    } catch {}
  }
}

export function restart() {
  if (process.platform === 'darwin') {
    const res = spawnSync('launchctl', ['kickstart', '-k', `${DOMAIN}/${LABEL}`], { encoding: 'utf8' });
    return res.status === 0 ? null : res.stderr.trim();
  }
  stop();
  return start(loadConfig());
}

export function uninstall() {
  stop();
  if (process.platform === 'darwin') {
    fs.rmSync(PLIST, { force: true });
  } else if (process.platform === 'win32') {
    fs.rmSync(WIN_STARTUP, { force: true });
    fs.rmSync(PID_FILE, { force: true });
  }
}

export function installAgent(cfg) {
  if (process.platform === 'win32') {
    fs.mkdirSync(path.dirname(WIN_STARTUP), { recursive: true });
    const vbs = `CreateObject("Wscript.Shell").Run """${process.execPath}"" ""${path.join(ROOT, 'src/server.js')}""", 0, False\n`;
    fs.writeFileSync(WIN_STARTUP, vbs, 'utf8');
    start(cfg);
    return null;
  }
  return start(cfg);
}

/** pid listening on the router port, or null. */
export function listenerPid(port) {
  if (process.platform === 'win32') {
    try {
      const out = execFileSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8' });
      for (const line of out.split('\n')) {
        const parts = line.trim().split(/\s+/);
        if (parts[0] === 'TCP' && parts[1]?.endsWith(`:${port}`) && parts[3] === 'LISTENING') {
          return Number(parts[4]);
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  const res = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' });
  const pid = res.stdout?.trim().split('\n')[0];
  return pid ? Number(pid) : null;
}
