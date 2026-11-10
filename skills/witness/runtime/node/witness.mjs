#!/usr/bin/env node
// Witness CLI (TypeScript / @playwright/test projects). Run from the project root.
//
//   witness setup   [--base-url URL] [--role name=storageStatePath ...] [--auth-setup "cmd"] [--test-dir dir] [--config file]
//   witness doctor
//   witness record  <flow> [--role r] [--start /path] [--replace] [--dry-run] [--timeout-min 30]
//   witness import  <flow> --from <dir> [--role r] [--start /path] [--replace]
//   witness analyze <flow> [--spec path] [--runs 2]
//   witness verify  <flow> --spec <path> [--repeat N] [--throttle N] [--skip-repeat]
//   witness lock    <flow>
//   witness status
//
// Every command prints a short Markdown summary on stdout; details are written as JSON under .witness/.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { readJSON, writeJSON, exists, stamp, gitInfo, copyDir, run, log, rel } from './lib/util.mjs';
import { loadConfig, projectPaths, roleStorage, credentialValues, ensureGitignore, DEFAULT_CONFIG } from './lib/config.mjs';
import { readHar } from './lib/har.mjs';
import { runSpec, projectTestDirs } from './lib/runner.mjs';
import { buildAnalysis, analysisSummary } from './lib/analysis.mjs';
import { compareFidelity, vacuityPlan, vacuityResults, lockCheck, lint, secretScan, assertionSignature } from './lib/verify.mjs';

const projectDir = process.cwd();
const P = projectPaths(projectDir);

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      const next = argv[i + 1];
      const val = v !== undefined ? v : (next !== undefined && !next.startsWith('--') ? (i++, next) : true);
      if (out[k] === undefined) out[k] = val; else out[k] = [].concat(out[k], val);
    } else out._.push(a);
  }
  return out;
}

const print = (s) => process.stdout.write(s.endsWith('\n') ? s : s + '\n');
const fail = (msg, code = 2) => { print(`**Witness error:** ${msg}`); process.exit(code); };
const flowName = (f) => {
  if (!f) fail('missing <flow> name');
  if (!/^[a-z0-9][a-z0-9-_]*$/i.test(f)) fail(`flow names use letters, digits, - and _ (got "${f}")`);
  return f;
};
const npx = () => (process.platform === 'win32' ? 'npx.cmd' : 'npx');

// ------------------------------------------------------------------ setup / doctor

async function cmdSetup(args) {
  const pkg = exists('package.json') ? readJSON('package.json') : null;
  const hasPwTest = pkg && ({ ...pkg.dependencies, ...pkg.devDependencies })['@playwright/test'];
  const isPython = ['pyproject.toml', 'requirements.txt', 'pytest.ini', 'conftest.py'].some(exists);
  if (!hasPwTest && isPython) fail('this looks like a Python project; use the Python runtime: python -m witness_py setup');
  const cfg = exists(P.config) ? readJSON(P.config) : { ...DEFAULT_CONFIG, roles: {} };
  const configFile = args.config || ['playwright.config.ts', 'playwright.config.js', 'playwright.config.mjs'].find(exists) || cfg.playwrightConfig;
  cfg.playwrightConfig = configFile;
  if (args['base-url']) cfg.baseURL = args['base-url'];
  if (args['test-dir']) cfg.testDir = args['test-dir'];
  if (args['auth-setup']) cfg.authSetupCommand = args['auth-setup'];
  if (args['verify-project']) cfg.verifyProject = args['verify-project'];
  if (args.channel) cfg.browser = { ...cfg.browser, channel: args.channel };
  for (const r of [].concat(args.role || [])) {
    const [name, storage] = String(r).split('=');
    cfg.roles[name] = { ...(cfg.roles[name] || {}), storageState: storage || `playwright/.auth/${name}.json` };
  }
  for (const r of [].concat(args['role-env'] || [])) {
    const [name, user, pass] = String(r).split(/[=:,]/);
    cfg.roles[name] = { ...(cfg.roles[name] || {}), usernameEnv: user, passwordEnv: pass };
  }
  if (!args['test-dir'] && exists(configFile)) {
    try { const dirs = await projectTestDirs(projectDir, cfg); if (dirs[0]) cfg.testDir = rel(projectDir, dirs[0]) || '.'; } catch { /* keep */ }
  }
  writeJSON(P.config, cfg);
  fs.mkdirSync(P.flows, { recursive: true });
  const added = ensureGitignore(projectDir);
  const missing = [];
  if (!hasPwTest) missing.push('@playwright/test is not in package.json devDependencies');
  if (!exists(configFile)) missing.push(`no Playwright config found (${configFile})`);
  if (!Object.keys(cfg.roles).length) missing.push('no roles configured (add --role customer=playwright/.auth/customer.json)');
  if (!cfg.authSetupCommand) missing.push('no authSetupCommand (e.g. "npx playwright test --project=setup")');
  print(`# Witness setup\n\nWrote ${rel(projectDir, P.config)}${added.length ? ` and added ${added.join(', ')} to .gitignore` : ''}.\n\n` +
    '```json\n' + JSON.stringify(cfg, null, 2) + '\n```\n' +
    (missing.length ? `\nStill needed:\n${missing.map((m) => `- ${m}`).join('\n')}\n` : '\nReady to record.\n'));
}

async function cmdDoctor() {
  const lines = ['# Witness doctor', ''];
  const ok = (b, m) => lines.push(`- ${b ? 'ok' : 'PROBLEM'}: ${m}`);
  const v = await run(npx(), ['playwright', '--version'], { cwd: projectDir, timeoutMs: 60000 });
  ok(v.code === 0, `Playwright ${v.out.trim().split('\n').pop()}`);
  let cfg = null;
  try { cfg = loadConfig(projectDir); ok(true, `.witness/config.json (baseURL ${cfg.baseURL})`); } catch (e) { ok(false, e.message); }
  if (cfg) {
    ok(exists(cfg.playwrightConfig), `Playwright config ${cfg.playwrightConfig}`);
    for (const [name, r] of Object.entries(cfg.roles)) {
      const s = r.storageState ? path.resolve(projectDir, r.storageState) : null;
      ok(!!s, `role ${name}: storageState ${r.storageState || '(none)'}${s && exists(s) ? '' : ' (not created yet; created by authSetupCommand)'}`);
      for (const k of ['usernameEnv', 'passwordEnv']) if (r[k]) ok(!!process.env[r[k]], `role ${name}: env ${r[k]} ${process.env[r[k]] ? 'set' : 'NOT set'}`);
    }
    try {
      const res = await fetch(cfg.baseURL, { redirect: 'manual' });
      ok(true, `app reachable at ${cfg.baseURL} (HTTP ${res.status})`);
    } catch (e) { ok(false, `app not reachable at ${cfg.baseURL}: ${e.message}`); }
    const gi = exists('.gitignore') ? fs.readFileSync('.gitignore', 'utf8') : '';
    ok(gi.includes('.witness/recordings/'), '.witness/recordings/ is gitignored');
  }
  print(lines.join('\n'));
}

// ------------------------------------------------------------------ record / import

// Saved logins go stale (sessions expire, servers restart), so refresh them before every
// recording or replay when an authSetupCommand is configured. Verify runs use the project's
// own setup project, which logs in fresh each time.
async function ensureStorage(cfg, role) {
  const storage = roleStorage(projectDir, cfg, role);
  if (!storage) return null;
  if (cfg.authSetupCommand) {
    log(`refreshing login state: ${cfg.authSetupCommand}`);
    const r = await run(cfg.authSetupCommand, [], { cwd: projectDir, shell: true, timeoutMs: 300000 });
    if (r.code !== 0 || !exists(storage)) fail(`authSetupCommand failed or did not create ${rel(projectDir, storage)}:\n\n\`\`\`\n${r.out.slice(-2000)}\n\`\`\``);
  } else if (!exists(storage)) {
    fail(`no saved login for role "${role}" at ${rel(projectDir, storage)} and no authSetupCommand configured`);
  }
  return storage;
}

function archiveExisting(flow) {
  const dir = P.recording(flow);
  if (!exists(dir)) return null;
  const dest = path.join(P.recordings, '_history', flow, stamp());
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.renameSync(dir, dest);
  return dest;
}

function updateFlowMeta(flow, patch) {
  const file = P.flowMeta(flow);
  const cur = readJSON(file, {});
  const next = { flow, ...cur, ...patch };
  writeJSON(file, next);
  return next;
}

function newVersion(flow, meta) {
  const cur = readJSON(P.flowMeta(flow), {});
  const version = (cur.version || 0) + 1;
  const history = [...(cur.history || []), { version, recordedAt: meta.recordedAt, author: meta.author, gitSha: meta.gitSha }];
  // A new recording invalidates the lock: checkpoints are re-derived from the new evidence.
  return updateFlowMeta(flow, { role: meta.role, start: meta.start, version, history, checkpoints: undefined, lockedAt: undefined });
}

async function cmdRecord(args) {
  const flow = flowName(args._[1]);
  const cfg = loadConfig(projectDir);
  const dir = P.recording(flow);
  if (exists(path.join(dir, 'raw.spec.ts')) && !args.replace) fail(`a recording for "${flow}" already exists. Use /witness:re-record ${flow} (witness record ${flow} --replace).`);
  const role = args.role || Object.keys(cfg.roles)[0] || 'none';
  const start = args.start || '/';
  // A dry run only prints the command; it must not log in or touch the app.
  const storage = args['dry-run'] ? roleStorage(projectDir, cfg, role) : await ensureStorage(cfg, role);
  const startUrl = new URL(start, cfg.baseURL).toString();
  const origin = new URL(cfg.baseURL).origin;
  const codegenArgs = ['playwright', 'codegen', startUrl, '--target', 'playwright-test',
    '-o', path.join(dir, 'raw.spec.ts'), '--save-har', path.join(dir, 'network.har'), '--save-har-glob', `${origin}/**`,
    '--test-id-attribute', cfg.testIdAttribute || 'data-testid'];
  if (storage) codegenArgs.push('--load-storage', storage);
  if (cfg.browser.locale) codegenArgs.push('--lang', cfg.browser.locale);
  if (cfg.browser.timezoneId) codegenArgs.push('--timezone', cfg.browser.timezoneId);
  if (cfg.browser.viewport) codegenArgs.push('--viewport-size', `${cfg.browser.viewport[0]}, ${cfg.browser.viewport[1]}`);
  if (cfg.browser.channel) codegenArgs.push('--channel', cfg.browser.channel);
  if (args['dry-run']) { print('```\nnpx ' + codegenArgs.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ') + '\n```'); return; }

  const archived = args.replace ? archiveExisting(flow) : null;
  fs.mkdirSync(dir, { recursive: true });
  const meta = { flow, role, start, startUrl, baseURL: cfg.baseURL, language: 'typescript', recordedAt: new Date().toISOString(), ...gitInfo(projectDir), status: 'recording', browser: cfg.browser };
  writeJSON(path.join(dir, 'meta.json'), meta);
  log(`recording "${flow}" as ${role} from ${startUrl}. Close the browser window when you are done.`);
  const timeoutMs = Number(args['timeout-min'] || 30) * 60000;
  const code = await new Promise((resolve) => {
    const child = spawn(npx(), codegenArgs, { cwd: projectDir, stdio: 'inherit', shell: process.platform === 'win32' });
    const t = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.on('close', (c) => { clearTimeout(t); resolve(c); });
  });
  const spec = path.join(dir, 'raw.spec.ts');
  if (!exists(spec)) { meta.status = 'abandoned'; writeJSON(path.join(dir, 'meta.json'), meta); fail(`no recording was saved (codegen exit ${code}). Run the command again to retry.`, 1); }
  const actions = (fs.readFileSync(spec, 'utf8').match(/await page/g) || []).length;
  meta.status = 'recorded';
  meta.recordedEndedAt = new Date().toISOString();
  writeJSON(path.join(dir, 'meta.json'), meta);
  const fm = newVersion(flow, meta);
  print(`# Recording saved: ${flow}\n\n- ${actions} recorded actions\n- raw: ${rel(projectDir, spec)}\n- network: ${rel(projectDir, path.join(dir, 'network.har'))}\n- version: v${fm.version}${archived ? ` (previous recording archived to ${rel(projectDir, archived)})` : ''}\n\nNext: witness analyze ${flow}`);
}

async function cmdImport(args) {
  const flow = flowName(args._[1]);
  if (!args.from) fail('--from <dir> is required');
  const src = path.resolve(args.from);
  const dir = P.recording(flow);
  if (exists(dir) && !args.replace) fail(`a recording for "${flow}" already exists (use --replace)`);
  const cfg = loadConfig(projectDir);
  if (args.replace) archiveExisting(flow);
  copyDir(src, dir);
  const meta = { flow, role: args.role || 'none', start: args.start || '/', baseURL: cfg.baseURL, language: 'typescript', recordedAt: new Date().toISOString(), ...gitInfo(projectDir), ...readJSON(path.join(dir, 'meta.json'), {}), status: 'recorded', imported: true };
  if (args.role) meta.role = args.role;
  writeJSON(path.join(dir, 'meta.json'), meta);
  newVersion(flow, meta);
  print(`Imported recording "${flow}" from ${src}.`);
}

// ------------------------------------------------------------------ analyze

async function cmdAnalyze(args) {
  const flow = flowName(args._[1]);
  const cfg = loadConfig(projectDir);
  const dir = P.recording(flow);
  const meta = readJSON(path.join(dir, 'meta.json'), null);
  if (!meta) fail(`no recording for "${flow}". Run /witness:record ${flow} first.`);
  const spec = args.spec ? path.resolve(args.spec) : path.join(dir, 'raw.spec.ts');
  const runsN = Number(args.runs || 2);
  const storage = await ensureStorage(cfg, meta.role);
  const runs = [];
  for (let i = 0; i < runsN; i++) {
    const r = await runSpec({ projectDir, cfg, spec, mode: 'observe', useProjectConfig: false, storageState: storage, label: `analyze-${flow}-${i + 1}` });
    if (!r.evidence.length) fail(`replay ${i + 1} produced no evidence. Playwright output:\n\n\`\`\`\n${r.output.slice(-3000)}\n\`\`\``, 1);
    runs.push(r.evidence[0]);
    writeJSON(path.join(dir, 'evidence', `${args.spec ? 'prepared' : 'raw'}-run-${i + 1}.json`), r.evidence[0]);
    // A failed replay says what is wrong; repeating it only repeats the same timeouts.
    if (r.evidence[0].status !== 'passed' && !args['all-runs']) { if (i + 1 < runsN) log('replay failed; skipping further runs (use --all-runs to force)'); break; }
  }
  const harCalls = args.spec && !args['compare-har'] ? null : readHar(path.join(dir, 'network.har'));
  const origin = new URL(cfg.baseURL).origin;
  const analysis = buildAnalysis({ flow, runs, harCalls, origin });
  analysis.spec = rel(projectDir, spec);
  analysis.kind = args.spec ? 'prepared' : 'raw';
  writeJSON(path.join(dir, 'analysis.json'), analysis);
  const md = analysisSummary(analysis);
  fs.writeFileSync(path.join(dir, 'analysis.md'), md);
  print(md + `\nFull detail: ${rel(projectDir, path.join(dir, 'analysis.json'))}`);
}

// ------------------------------------------------------------------ verify / lock

async function cmdVerify(args) {
  const flow = flowName(args._[1]);
  if (!args.spec) fail('--spec <path to the generated test> is required');
  const cfg = loadConfig(projectDir);
  const dir = P.recording(flow);
  const analysis = readJSON(path.join(dir, 'analysis.json'), null);
  if (!analysis) fail(`no analysis for "${flow}". Run witness analyze ${flow} first.`);
  const spec = path.resolve(args.spec);
  const report = { flow, spec: rel(projectDir, spec), verifiedAt: new Date().toISOString(), checks: {} };

  const observe = await runSpec({ projectDir, cfg, spec, mode: 'observe', useProjectConfig: true, label: `verify-${flow}-observe` });
  const ev = observe.evidence[0];
  if (!ev) fail(`the test produced no evidence (did it run?). Playwright output:\n\n\`\`\`\n${observe.output.slice(-3000)}\n\`\`\``, 1);
  if (observe.evidence.length > 1) report.note = `spec has ${observe.evidence.length} tests; verified the first ("${ev.title}")`;
  report.checks.run = { ok: ev.status === 'passed', errors: ev.status === 'passed' ? [] : [`test ${ev.status}: ${ev.error || ''}`] };
  report.checks.fidelity = compareFidelity(analysis.baseline, ev);

  const plan = vacuityPlan(ev);
  if (ev.status === 'passed' && plan.assertions.length) {
    const vac = await runSpec({ projectDir, cfg, spec, mode: 'vacuity', useProjectConfig: true, vacuityPlan: plan, label: `verify-${flow}-vacuity` });
    const vev = vac.evidence[0];
    report.checks.vacuity = vev ? vacuityResults(plan, vev) : { ok: false, errors: ['vacuity run produced no evidence'], warnings: [] };
  } else {
    report.checks.vacuity = { ok: false, errors: plan.assertions.length ? ['skipped: test did not pass'] : ['no locator or page assertions to check'], warnings: [] };
  }

  const repeat = Number(args.repeat || cfg.verify.repeat || 3);
  const throttle = Number(args.throttle ?? cfg.verify.cpuThrottle ?? 4);
  if (!args['skip-repeat'] && ev.status === 'passed') {
    const rep = await runSpec({ projectDir, cfg, spec, mode: 'plain', useProjectConfig: true, repeat, throttle, label: `verify-${flow}-repeat` });
    const passed = rep.evidence.filter((e) => e.status === 'passed').length;
    const firstFail = rep.evidence.find((e) => e.status !== 'passed');
    report.checks.repeat = { ok: passed === repeat && rep.evidence.length === repeat, runs: repeat, passed, cpuThrottle: throttle, errors: passed === repeat ? [] : [`passed ${passed}/${repeat} repeated runs${firstFail ? `; first failure: ${(firstFail.error || '').split('\n')[0]}` : ''}`] };
  } else {
    report.checks.repeat = { ok: !!args['skip-repeat'], skipped: true, errors: args['skip-repeat'] ? [] : ['skipped: test did not pass'], warnings: args['skip-repeat'] ? ['repeat runs skipped'] : [] };
  }

  report.checks.lint = lint(spec);
  report.checks.secrets = secretScan(spec, credentialValues(cfg));
  const flowMeta = readJSON(P.flowMeta(flow), {});
  report.checks.lock = lockCheck(flowMeta, ev);
  report.assertions = (ev.assertions || []).map((a) => ({ order: a.order, afterStep: a.afterStep, locator: a.locator, matcher: a.matcher, isNot: a.isNot, args: a.args, signature: assertionSignature(a), passed: a.passed }));
  report.ok = Object.values(report.checks).every((c) => c.ok);
  writeJSON(path.join(dir, 'verify-report.json'), report);
  writeJSON(path.join(dir, 'evidence', 'verify-observe.json'), ev);
  updateFlowMeta(flow, { spec: report.spec, lastVerified: { at: report.verifiedAt, ok: report.ok, repeat: report.checks.repeat.passed !== undefined ? `${report.checks.repeat.passed}/${report.checks.repeat.runs}` : null } });

  const L = [`# Witness verify: ${flow} — ${report.ok ? 'PASS' : 'FAIL'}`, '', `Spec: ${report.spec}`];
  if (report.note) L.push(`Note: ${report.note}`);
  const names = { run: 'Test passes', fidelity: 'Matches the recording', vacuity: 'Assertions are meaningful', repeat: 'Stable on repeat', lint: 'Test hygiene', secrets: 'No credentials in code', lock: 'Assertions match lock' };
  for (const [k, c] of Object.entries(report.checks)) {
    L.push('', `## ${c.ok ? 'ok' : 'FAIL'} — ${names[k]}${k === 'repeat' && c.runs ? ` (${c.passed}/${c.runs}, cpu x${c.cpuThrottle})` : ''}${k === 'fidelity' && c.stats ? ` (${c.stats.matchedRequired}/${c.stats.requiredActions} recorded actions)` : ''}`);
    for (const e of c.errors || []) L.push(`- error: ${e}`);
    for (const w of c.warnings || []) L.push(`- warning: ${w}`);
    for (const i of (c.info || []).slice(0, 8)) L.push(`- info: ${i}`);
  }
  L.push('', '## Assertions', ...report.assertions.map((a) => `- after step ${a.afterStep}: ${a.locator}.${a.isNot ? 'not.' : ''}${a.matcher} ${a.passed ? '' : '(FAILED)'}`));
  print(L.join('\n'));
  process.exit(report.ok ? 0 : 1);
}

async function cmdLock(args) {
  const flow = flowName(args._[1]);
  const dir = P.recording(flow);
  const report = readJSON(path.join(dir, 'verify-report.json'), null);
  if (!report) fail(`no verify report for "${flow}"`);
  const blocking = Object.entries(report.checks).filter(([k, c]) => k !== 'lock' && !c.ok);
  if (blocking.length) fail(`cannot lock: verify has failing checks (${blocking.map(([k]) => k).join(', ')})`);
  const checkpoints = report.assertions.filter((a) => a.locator).map((a) => ({ signature: a.signature, locator: a.locator, matcher: a.matcher, isNot: a.isNot, afterStep: a.afterStep }));
  updateFlowMeta(flow, { spec: report.spec, checkpoints, lockedAt: new Date().toISOString() });
  print(`Locked ${checkpoints.length} checkpoint(s) for "${flow}" in ${rel(projectDir, P.flowMeta(flow))}:\n${checkpoints.map((c) => `- ${c.locator} ${c.signature}`).join('\n')}`);
}

function cmdStatus() {
  const flows = exists(P.flows) ? fs.readdirSync(P.flows).filter((f) => f.endsWith('.json')).map((f) => readJSON(path.join(P.flows, f))) : [];
  if (!flows.length) return print('No flows recorded yet. Start with /witness:record <flow>.');
  print(['| Flow | Version | Spec | Locked | Last verified |', '|---|---|---|---|---|',
    ...flows.map((f) => `| ${f.flow} | v${f.version || 1} | ${f.spec || '—'} | ${f.checkpoints ? `${f.checkpoints.length} checkpoints` : 'no'} | ${f.lastVerified ? `${f.lastVerified.ok ? 'pass' : 'FAIL'} ${f.lastVerified.at.slice(0, 16)} (${f.lastVerified.repeat || ''})` : '—'} |`)].join('\n'));
}

// ------------------------------------------------------------------ main

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];
const commands = { setup: cmdSetup, doctor: cmdDoctor, record: cmdRecord, import: cmdImport, analyze: cmdAnalyze, verify: cmdVerify, lock: cmdLock, status: cmdStatus };
if (!commands[cmd]) {
  print('Usage: witness <setup|doctor|record|import|analyze|verify|lock|status> [flow] [options]\nSee skills/witness/SKILL.md.');
  process.exit(cmd ? 2 : 0);
}
Promise.resolve(commands[cmd](args)).catch((e) => fail(e.stack || e.message, 1));
