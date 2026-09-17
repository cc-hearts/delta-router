#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CERTS = path.join(DIR, 'certs');
fs.mkdirSync(CERTS, { recursive: true });

const cfgFile = path.join(DIR, 'config.json');
const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
const sans = (cfg.intercept || []).map((h) => `DNS:${h}`).join(',');
console.log(`SANs: ${sans}`);

const caKey = path.join(CERTS, 'ca.key');
const caPem = path.join(CERTS, 'ca.pem');
const force = process.argv.includes('--force');

if (force || !fs.existsSync(caPem) || !fs.existsSync(caKey)) {
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-days', '3650', '-nodes',
    '-keyout', caKey, '-out', caPem,
    '-subj', '/CN=delta-router local CA/O=delta-router',
  ], { stdio: 'inherit' });
  console.log('created CA (remember: node src/cli.js trust-ca)');
} else {
  console.log(`reusing existing CA ${caPem}`);
}

const serverKey = path.join(CERTS, 'server.key');
const serverCsr = path.join(CERTS, 'server.csr');
const serverExt = path.join(CERTS, 'server.ext');
const serverCrt = path.join(CERTS, 'server.crt');
const caSrl = path.join(CERTS, 'ca.srl');

execFileSync('openssl', [
  'req', '-newkey', 'rsa:2048', '-nodes', '-sha256',
  '-keyout', serverKey, '-out', serverCsr,
  '-subj', `/CN=${cfg.intercept[0] || 'localhost'}`,
], { stdio: 'inherit' });

fs.writeFileSync(
  serverExt,
  `subjectAltName=${sans}\nextendedKeyUsage=serverAuth\nkeyUsage=digitalSignature,keyEncipherment\n`,
  'utf8',
);

execFileSync('openssl', [
  'x509', '-req', '-in', serverCsr, '-CA', caPem, '-CAkey', caKey,
  '-CAcreateserial', '-out', serverCrt, '-days', '825', '-sha256', '-extfile', serverExt,
], { stdio: 'inherit' });

fs.rmSync(serverCsr, { force: true });
fs.rmSync(serverExt, { force: true });
if (fs.existsSync(caSrl)) fs.rmSync(caSrl, { force: true });

try {
  fs.chmodSync(caKey, 0o600);
  fs.chmodSync(serverKey, 0o600);
} catch {
  // chmod may not be supported on Windows filesystems
}

console.log(`wrote ${CERTS}/{ca.pem,ca.key,server.crt,server.key}`);
