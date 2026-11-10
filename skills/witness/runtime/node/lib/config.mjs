// Loads .witness/config.json and resolves project paths.
import path from 'node:path';
import fs from 'node:fs';
import { readJSON, exists, WITNESS_DIR } from './util.mjs';

export const DEFAULT_CONFIG = {
  version: 1,
  language: 'typescript',
  baseURL: 'http://localhost:3000',
  testDir: 'tests',
  playwrightConfig: 'playwright.config.ts',
  verifyProject: null,
  roles: {},
  authSetupCommand: null,
  browser: { channel: null, locale: 'en-US', timezoneId: 'UTC', viewport: [1280, 800] },
  testIdAttribute: 'data-testid',
  credentialEnv: [],
  verify: { repeat: 3, cpuThrottle: 4 },
};

export function projectPaths(projectDir) {
  const w = path.join(projectDir, WITNESS_DIR);
  return {
    root: projectDir,
    witness: w,
    config: path.join(w, 'config.json'),
    recordings: path.join(w, 'recordings'),
    flows: path.join(w, 'flows'),
    tmp: path.join(w, 'tmp'),
    recording: (flow) => path.join(w, 'recordings', flow),
    flowMeta: (flow) => path.join(w, 'flows', `${flow}.json`),
  };
}

export function loadConfig(projectDir) {
  const p = projectPaths(projectDir);
  if (!exists(p.config)) {
    throw new Error(`No ${path.relative(projectDir, p.config)} found. Run "witness setup" (or /witness:setup) first.`);
  }
  const user = readJSON(p.config);
  const cfg = { ...DEFAULT_CONFIG, ...user, browser: { ...DEFAULT_CONFIG.browser, ...(user.browser || {}) }, verify: { ...DEFAULT_CONFIG.verify, ...(user.verify || {}) } };
  return cfg;
}

export function roleStorage(projectDir, cfg, role) {
  if (!role || role === 'none') return null;
  const r = cfg.roles[role];
  if (!r) throw new Error(`Unknown role "${role}". Known roles: ${Object.keys(cfg.roles).join(', ') || '(none configured)'}`);
  return r.storageState ? path.resolve(projectDir, r.storageState) : null;
}

/** Values of credential env vars, used for the secret scan and redaction. */
export function credentialValues(cfg) {
  const names = new Set(cfg.credentialEnv || []);
  for (const r of Object.values(cfg.roles || {})) {
    for (const k of ['usernameEnv', 'passwordEnv']) if (r[k]) names.add(r[k]);
  }
  return [...names].map((n) => ({ name: n, value: process.env[n] })).filter((x) => x.value && x.value.length >= 4);
}

export function ensureGitignore(projectDir) {
  const gi = path.join(projectDir, '.gitignore');
  const lines = ['.witness/recordings/', '.witness/tmp/'];
  let cur = exists(gi) ? fs.readFileSync(gi, 'utf8') : '';
  const missing = lines.filter((l) => !cur.split(/\r?\n/).includes(l));
  if (missing.length) {
    if (cur && !cur.endsWith('\n')) cur += '\n';
    fs.writeFileSync(gi, cur + '# Witness: raw recordings may contain personal data; run artifacts are disposable\n' + missing.join('\n') + '\n');
  }
  return missing;
}
