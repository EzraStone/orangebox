import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(import.meta.dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'orangebox-install-'));
const expectedVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npmExecPath = process.env.npm_execpath;
const shim = process.platform === 'win32'
  ? path.join(temp, 'node_modules', '.bin', 'orangebox.cmd')
  : path.join(temp, 'node_modules', '.bin', 'orangebox');
const installedCli = path.join(temp, 'node_modules', 'orangebox-ai', 'bin', 'orangebox.mjs');

let tarball = null;
try {
  const tarballName = runNpm(['pack', '--silent'], { cwd: root, encoding: 'utf8' }).trim().split(/\r?\n/).at(-1);
  tarball = path.join(root, tarballName);
  runNpm(['install', '--prefix', temp, tarball], { stdio: 'inherit' });
  if (!fs.existsSync(shim)) throw new Error(`package manager did not create the orangebox executable at ${shim}`);
  const version = execFileSync(process.execPath, [installedCli, '--version'], { encoding: 'utf8' }).trim();
  if (version !== expectedVersion) throw new Error(`packed CLI reported ${version}, expected ${expectedVersion}`);
  console.log(`fresh install passed on ${process.platform}: orangebox v${version}`);
} finally {
  if (tarball) fs.rmSync(tarball, { force: true });
  fs.rmSync(temp, { recursive: true, force: true });
}

function runNpm(args, options) {
  if (npmExecPath) return execFileSync(process.execPath, [npmExecPath, ...args], options);
  return execFileSync(npm, args, { ...options, shell: process.platform === 'win32' });
}
