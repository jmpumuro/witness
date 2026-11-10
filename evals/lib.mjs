// Eval harness helpers: start demo apps, reset data, simulate a human recording.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const APPS = {
  shop: { port: 4101, dir: 'examples/shop' },
  clinic: { port: 4102, dir: 'examples/clinic' },
  library: { port: 4103, dir: 'examples/library' },
};

// Demo-only credentials for the in-memory demo apps.
export const DEMO_ENV = {
  SHOP_CUSTOMER_EMAIL: 'alice@shop.test', SHOP_CUSTOMER_PASSWORD: 'alice-pass',
  SHOP_ADMIN_EMAIL: 'admin@shop.test', SHOP_ADMIN_PASSWORD: 'admin-pass',
  CLINIC_STAFF_EMAIL: 'frontdesk@clinic.test', CLINIC_STAFF_PASSWORD: 'desk-pass',
  LIBRARY_MEMBER_EMAIL: 'maya@library.test', LIBRARY_MEMBER_PASSWORD: 'maya-pass',
  LIBRARY_LIBRARIAN_EMAIL: 'lib@library.test', LIBRARY_LIBRARIAN_PASSWORD: 'lib-pass',
};

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { ...opts, shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; if (opts.echo) process.stdout.write(d); });
    child.stderr.on('data', (d) => { out += d; if (opts.echo) process.stderr.write(d); });
    child.on('close', (code) => resolve({ code, out }));
  });
}

async function up(port) {
  try { const r = await fetch(`http://localhost:${port}/login`); return r.status === 200; } catch { return false; }
}

/** Start any demo app that is not already running. Returns a stop() function. */
export async function startApps(names = Object.keys(APPS)) {
  const children = [];
  for (const name of names) {
    const a = APPS[name];
    if (await up(a.port)) continue;
    const child = spawn(process.execPath, [path.join(ROOT, a.dir, 'server.js')], { env: { ...process.env, TEST_MODE: '1', PORT: String(a.port) }, stdio: 'ignore' });
    children.push(child);
  }
  for (const name of names) {
    for (let i = 0; i < 50 && !(await up(APPS[name].port)); i++) await sleep(100);
    if (!(await up(APPS[name].port))) throw new Error(`${name} did not start on port ${APPS[name].port}`);
  }
  return () => children.forEach((c) => c.kill());
}

export async function resetApp(name) {
  const r = await fetch(`http://localhost:${APPS[name].port}/__test/reset`, { method: 'POST' });
  if (!r.ok) throw new Error(`reset ${name} failed (is it running with TEST_MODE=1?)`);
}

/** Replace {{OVERDUE_DAYS:2026-11-01T12:00:00Z}}-style placeholders with values for "now". */
export function templateRecording(text) {
  const DAY = 86400000;
  return text.replace(/\{\{DAYS_UNTIL:([^}]+)\}\}/g, (m, iso) => String(Math.round((new Date(iso).getTime() - Date.now()) / DAY)))
    .replace(/\{\{DAYS_SINCE:([^}]+)\}\}/g, (m, iso) => String(-Math.round((new Date(iso).getTime() - Date.now()) / DAY)))
    // Same wording as the library app's loans page.
    .replace(/\{\{OVERDUE_TEXT:([^}]+)\}\}/g, (m, iso) => {
      const days = Math.round((new Date(iso).getTime() - Date.now()) / DAY);
      if (days < 0) return `Overdue by ${-days} day${days === -1 ? '' : 's'}`;
      return days === 0 ? 'Due today' : `Due in ${days} day${days === 1 ? '' : 's'}`;
    });
}

/**
 * Simulate what `witness record` saves: raw spec (codegen output), network.har, meta.json.
 * The human's actual behaviour (human.spec.ts if present, else the raw spec) is executed once
 * against the app with HAR capture, so the app's data changes exactly as during a real recording.
 */
export async function simulateRecording({ caseDir, lang, projectDir, outDir, role, start, baseURL, storageState }) {
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const rec = path.join(caseDir, 'recording', lang);
  const rawName = lang === 'ts' ? 'raw.spec.ts' : 'raw_test.py';
  const raw = templateRecording(fs.readFileSync(path.join(rec, rawName), 'utf8'));
  fs.writeFileSync(path.join(outDir, rawName), raw);
  const humanFile = fs.existsSync(path.join(rec, lang === 'ts' ? 'human.spec.ts' : 'human_test.py')) ? (lang === 'ts' ? 'human.spec.ts' : 'human_test.py') : rawName;
  const human = templateRecording(fs.readFileSync(path.join(rec, humanFile), 'utf8'));
  const har = path.join(outDir, 'network.har');
  const origin = new URL(baseURL).origin;

  let r;
  if (lang === 'ts') {
    // Run inside the project so @playwright/test resolves.
    const simDir = path.join(projectDir, '.witness', 'tmp', `simulate-${Date.now()}`);
    fs.mkdirSync(simDir, { recursive: true });
    fs.writeFileSync(path.join(simDir, 'human.spec.ts'), human);
    fs.writeFileSync(path.join(simDir, 'sim.config.ts'), `export default ${JSON.stringify({
      testDir: simDir, outputDir: path.join(simDir, 'out'), reporter: [['line']], retries: 0, workers: 1,
      use: { headless: true, channel: process.env.PW_CHANNEL || undefined, storageState: storageState || undefined, locale: 'en-US', timezoneId: 'UTC', viewport: { width: 1280, height: 800 },
        contextOptions: { recordHar: { path: har, urlFilter: `${origin}/**` } } },
    }, null, 2)};\n`);
    r = await run('npx', ['playwright', 'test', '-c', path.join(simDir, 'sim.config.ts')], { cwd: projectDir });
  } else {
    // Run inside the project (its conftest applies); the Witness plugin's context overrides add the
    // saved login and HAR capture to the browser context, exactly like codegen --load-storage --save-har.
    const simDir = path.join(projectDir, '.witness', 'tmp', `simulate-${Date.now()}`);
    fs.mkdirSync(simDir, { recursive: true });
    fs.writeFileSync(path.join(simDir, 'human_test.py'), human);
    const overrides = { storage_state: storageState || undefined, locale: 'en-US', timezone_id: 'UTC', viewport: { width: 1280, height: 800 }, record_har_path: har, record_har_url_filter: `${origin}/**` };
    r = await run('python3', ['-m', 'pytest', '-q', '-p', 'no:cacheprovider', '-p', 'witness_py.pytest_plugin', path.join(simDir, 'human_test.py')], {
      cwd: projectDir,
      env: { ...process.env, WITNESS_MODE: 'plain', WITNESS_CONTEXT_OVERRIDES: JSON.stringify(overrides), PYTHONPATH: path.join(ROOT, 'skills/witness/runtime/python') },
    });
  }
  if (r.code !== 0 || !fs.existsSync(har)) throw new Error(`simulated recording failed:\n${r.out.slice(-3000)}`);
  fs.writeFileSync(path.join(outDir, 'meta.json'), JSON.stringify({ role, start, startUrl: new URL(start, baseURL).toString(), baseURL, language: lang === 'ts' ? 'typescript' : 'python', recordedAt: new Date().toISOString(), author: 'eval-harness', gitSha: null, simulated: true }, null, 2));
}
