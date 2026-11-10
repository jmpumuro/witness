// Shared helpers for the Witness Node runtime. No third-party dependencies.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

export const WITNESS_DIR = '.witness';

export function readJSON(file, fallback = undefined) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    if (fallback !== undefined) return fallback;
    throw new Error(`Could not read ${file}: ${e.message}`);
  }
}

export function writeJSON(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

export function exists(p) { try { fs.accessSync(p); return true; } catch { return false; } }

export function stamp() { return new Date().toISOString().replace(/[:.]/g, '-'); }

/** Replace id-like path segments with :id so calls can be compared across runs. */
export function templatePath(p) {
  if (!p) return p;
  const [pathname] = String(p).split('?');
  return pathname.split('/').map((seg) => {
    if (!seg) return seg;
    if (/^\d+$/.test(seg)) return ':id';
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return ':id';
    if (/^[0-9a-f]{16,}$/i.test(seg)) return ':id';
    if (/\d/.test(seg) && /^[A-Za-z]{0,4}[-_]?\d[\w-]*$/.test(seg)) return ':id';
    return seg;
  }).join('/');
}

export function queryKeys(p) {
  const i = String(p).indexOf('?');
  if (i < 0) return '';
  return [...new URLSearchParams(String(p).slice(i + 1)).keys()].sort().join('&');
}

export function statusClass(s) {
  if (s === undefined || s === null) return 'none';
  return `${String(s)[0]}xx`;
}

export const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Normalize text for "same except numbers" comparisons. */
export function digitsMasked(s) { return String(s).replace(/\d+/g, '#'); }

/** Build a regex source that matches s with every number replaced by \d+. */
export function regexFor(s) {
  const esc = String(s).replace(/[.*+?^${}()|[\]\\\/]/g, '\\$&');
  return esc.replace(/\d+/g, '\\d+');
}

/** Remove the routeFromHAR call codegen adds with --save-har: replays must hit the live app, not the HAR. */
export function stripHarReplay(src) {
  return String(src).replace(/^[ \t]*(?:await[ \t]+)?(?:page|context)\.routeFromHAR\([\s\S]*?\);[ \t]*\r?\n/gm, '');
}

export function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'], shell: opts.shell ?? process.platform === 'win32' });
    let out = '';
    child.stdout.on('data', (d) => { out += d; if (opts.echo) process.stderr.write(d); });
    child.stderr.on('data', (d) => { out += d; if (opts.echo) process.stderr.write(d); });
    let timer = null;
    if (opts.timeoutMs) timer = setTimeout(() => { child.kill('SIGTERM'); out += `\n[witness] timed out after ${opts.timeoutMs}ms\n`; }, opts.timeoutMs);
    child.on('close', (code) => { if (timer) clearTimeout(timer); resolve({ code, out }); });
  });
}

export function runSync(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', shell: process.platform === 'win32', ...opts });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

export function gitInfo(cwd) {
  const email = runSync('git', ['config', 'user.email'], { cwd }).out.trim() || null;
  const sha = runSync('git', ['rev-parse', '--short', 'HEAD'], { cwd });
  return { author: email, gitSha: sha.code === 0 ? sha.out.trim() : null };
}

export function copyDir(src, dest, { exclude = [] } = {}) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (exclude.includes(entry.name)) continue;
    const s = path.join(src, entry.name), d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d, { exclude });
    else if (entry.isFile()) fs.copyFileSync(s, d);
  }
}

export function walk(dir, pred = () => true, acc = []) {
  if (!exists(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, pred, acc);
    else if (pred(p)) acc.push(p);
  }
  return acc;
}

export function rel(from, p) { return path.relative(from, p).split(path.sep).join('/'); }

export function log(...a) { process.stderr.write('[witness] ' + a.join(' ') + '\n'); }
