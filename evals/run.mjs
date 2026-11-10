#!/usr/bin/env node
// Witness eval harness.
//
//   node evals/run.mjs [--lang ts|py|both] [--case <name>] [--skip-mutants] [--candidates <dir>] [--keep] [--stop-after analyze]
//
// For every case in evals/cases:
//   1. reset the demo app and simulate the human recording (raw codegen output + HAR + meta)
//   2. witness import + analyze → check the findings against case.json "expect.analysis"
//   3. if the case has a prepared replay: analyze it → check "expect.prepared"
//   4. verify the golden test (or an agent's candidate test from --candidates) → must PASS, then lock
//   5. verify each mutant → must FAIL on the named check
//
// Set PW_CHANNEL=chrome to use an installed Chrome instead of Playwright's bundled browsers.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, APPS, DEMO_ENV, startApps, resetApp, simulateRecording, run } from './lib.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]);
  return acc;
}, []));
const langs = args.lang === 'both' ? ['ts', 'py'] : [args.lang || 'ts'];
Object.assign(process.env, DEMO_ENV);

const CASES_DIR = path.join(ROOT, 'evals', 'cases');
const cases = fs.readdirSync(CASES_DIR).filter((c) => !args.case || c === args.case).sort();
const results = [];

function witness(lang, projectDir, cmdArgs) {
  if (lang === 'ts') return run(process.execPath, [path.join(ROOT, 'skills/witness/runtime/node/witness.mjs'), ...cmdArgs], { cwd: projectDir });
  return run('python3', ['-m', 'witness_py', ...cmdArgs], { cwd: projectDir, env: { ...process.env, PYTHONPATH: path.join(ROOT, 'skills/witness/runtime/python') } });
}

const readJSON = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

function checkAnalysis(a, exp = {}) {
  const problems = [];
  for (const d of exp.divergences || []) {
    if (!a.divergences.some((x) => x.kind === d.kind && x.method === d.method && (x.template === d.template || x.template.startsWith(d.template + '?')))) problems.push(`expected divergence ${d.kind} ${d.method} ${d.template}; got ${JSON.stringify(a.divergences.map((x) => `${x.kind} ${x.method} ${x.template}`))}`);
  }
  if (Array.isArray(exp.divergences) && exp.divergences.length === 0) {
    const bad = a.divergences.filter((x) => x.kind !== 'missing_read');
    if (bad.length) problems.push(`expected no divergences; got ${JSON.stringify(bad.map((x) => `${x.kind} ${x.method} ${x.template}`))}`);
  }
  for (const [reason, n] of Object.entries(exp.optionalSteps || {})) {
    const got = a.steps.filter((s) => s.optional === reason).length;
    if (got < n) problems.push(`expected ${n} optional step(s) "${reason}", got ${got}`);
  }
  const top = a.checkpointCandidates.slice(0, 8).map((c) => c.line).join('\n');
  for (const t of exp.candidatesInclude || []) if (!top.includes(t)) problems.push(`expected "${t}" among the top 8 checkpoint candidates`);
  if (exp.delayedEffect && !a.steps.some((s) => s.delayedEffect)) problems.push('expected a delayed effect to be detected');
  if (exp.dialogs && a.dialogs.length < exp.dialogs) problems.push(`expected ${exp.dialogs} dialog(s), got ${a.dialogs.length}`);
  if (exp.repeatable !== undefined && a.repeatable !== exp.repeatable) problems.push(`expected repeatable=${exp.repeatable}, got ${a.repeatable}`);
  if (exp.runsFail && !a.runs.some((r) => r.status !== 'passed')) problems.push('expected the raw replay to fail');
  if (exp.timeDependent && !a.timeDependent.length) problems.push('expected time-dependent text to be flagged');
  return problems;
}

async function runCase(name, lang) {
  const c = readJSON(path.join(CASES_DIR, name, 'case.json'));
  const caseDir = path.join(CASES_DIR, name);
  const projectDir = path.join(ROOT, APPS[c.app].dir, lang === 'ts' ? 'e2e' : 'e2e-py');
  const testsDir = path.join(projectDir, 'tests');
  const rec = { case: name, lang, steps: {}, problems: [] };
  const t0 = Date.now();
  const step = async (label, fn) => {
    const s = Date.now();
    try { const r = await fn(); rec.steps[label] = { ok: !r || !r.length, ms: Date.now() - s, problems: r || [] }; rec.problems.push(...(r || []).map((p) => `${label}: ${p}`)); }
    catch (e) { rec.steps[label] = { ok: false, ms: Date.now() - s, problems: [e.message.slice(0, 1500)] }; rec.problems.push(`${label}: ${e.message.slice(0, 1500)}`); throw e; }
  };
  const goldenDir = args.candidates ? path.join(path.resolve(args.candidates), name) : path.join(caseDir, 'golden', lang);
  const goldenFiles = fs.existsSync(goldenDir) ? fs.readdirSync(goldenDir).filter((f) => /\.spec\.ts$|^test_.*\.py$/.test(f)) : [];
  const placed = [];
  try {
    await resetApp(c.app);
    fs.rmSync(path.join(projectDir, '.witness', 'recordings', c.flow), { recursive: true, force: true });
    fs.rmSync(path.join(projectDir, '.witness', 'flows', `${c.flow}.json`), { force: true });

    await step('simulate', async () => {
      const auth = lang === 'ts'
        ? await run('npx', ['playwright', 'test', '--project=setup'], { cwd: projectDir })
        : await run('python3', ['-m', 'pytest', '-q', '-p', 'no:cacheprovider', 'tests/auth_setup.py'], { cwd: projectDir });
      if (auth.code !== 0) throw new Error('auth setup failed:\n' + auth.out.slice(-1500));
      const storage = path.join(projectDir, 'playwright', '.auth', `${c.role}.json`);
      await simulateRecording({ caseDir, lang, projectDir, outDir: path.join(projectDir, '.witness', 'tmp', `sim-${c.flow}`), role: c.role, start: c.start, baseURL: `http://localhost:${APPS[c.app].port}`, storageState: storage });
    });
    await step('import', async () => {
      const r = await witness(lang, projectDir, ['import', c.flow, '--from', path.join(projectDir, '.witness', 'tmp', `sim-${c.flow}`), '--role', c.role, '--start', c.start, '--replace']);
      if (r.code !== 0) throw new Error(r.out.slice(-1500));
    });
    await step('analyze', async () => {
      const r = await witness(lang, projectDir, ['analyze', c.flow]);
      if (r.code !== 0) throw new Error(r.out.slice(-2500));
      return checkAnalysis(readJSON(path.join(projectDir, '.witness', 'recordings', c.flow, 'analysis.json')), c.expect.analysis);
    });
    if (args['stop-after'] === 'analyze') { rec.steps.verify = { ok: true, ms: 0, problems: [], skipped: 'stop-after analyze' }; return rec; }
    const preparedName = lang === 'ts' ? 'prepared.spec.ts' : 'prepared_test.py';
    const prepared = path.join(caseDir, 'recording', lang, preparedName);
    if (fs.existsSync(prepared)) {
      await step('analyze-prepared', async () => {
        const dest = path.join(projectDir, '.witness', 'recordings', c.flow, preparedName);
        fs.copyFileSync(prepared, dest);
        const r = await witness(lang, projectDir, ['analyze', c.flow, '--spec', dest]);
        if (r.code !== 0) throw new Error(r.out.slice(-2500));
        return checkAnalysis(readJSON(path.join(projectDir, '.witness', 'recordings', c.flow, 'analysis.json')), c.expect.prepared);
      });
    }
    if (!goldenFiles.length) throw new Error(`no test to verify in ${goldenDir}`);
    const supportSrc = path.join(ROOT, 'evals', 'support', c.app, lang);
    if (fs.existsSync(supportSrc)) {
      fs.mkdirSync(path.join(testsDir, 'support'), { recursive: true });
      for (const f of fs.readdirSync(supportSrc, { withFileTypes: true }).filter((d) => d.isFile())) fs.copyFileSync(path.join(supportSrc, f.name), path.join(testsDir, 'support', f.name));
    }
    for (const f of goldenFiles) { fs.copyFileSync(path.join(goldenDir, f), path.join(testsDir, f)); placed.push(path.join(testsDir, f)); }
    const spec = path.relative(projectDir, placed[0]);
    await step('verify', async () => {
      const r = await witness(lang, projectDir, ['verify', c.flow, '--spec', spec]);
      rec.verifyOutput = r.out.split('\n').filter((l) => /^#|error:|FAIL/.test(l)).join('\n');
      return r.code === 0 ? [] : ['golden test did not pass verify:\n' + rec.verifyOutput];
    });
    await step('lock', async () => {
      const r = await witness(lang, projectDir, ['lock', c.flow]);
      return r.code === 0 ? [] : [r.out.slice(-800)];
    });
    if (!args['skip-mutants'] && !args.candidates) {
      const mdir = path.join(caseDir, 'mutants', lang);
      for (const [m, check] of Object.entries(c.mutants || {})) {
        const file = fs.readdirSync(mdir).find((f) => f.startsWith(m + (lang === 'ts' ? '.spec.ts' : '')) || f === `test_${m.replace(/-/g, '_')}.py`);
        if (!file) { rec.problems.push(`mutant ${m}: no file`); continue; }
        await step(`mutant:${m}`, async () => {
          const dest = path.join(testsDir, lang === 'ts' ? `mutant-${m}.spec.ts` : `test_mutant_${m.replace(/-/g, '_')}.py`);
          fs.copyFileSync(path.join(mdir, file), dest);
          try {
            const r = await witness(lang, projectDir, ['verify', c.flow, '--spec', path.relative(projectDir, dest), '--skip-repeat']);
            const report = readJSON(path.join(projectDir, '.witness', 'recordings', c.flow, 'verify-report.json'));
            const out = [];
            if (r.code === 0) out.push(`mutant ${m} passed verify (should fail on "${check}")`);
            else if (report.checks[check]?.ok !== false) out.push(`mutant ${m} failed, but not on "${check}" (failed: ${Object.entries(report.checks).filter(([, v]) => !v.ok).map(([k]) => k).join(', ')})`);
            return out;
          } finally { fs.rmSync(dest, { force: true }); }
        });
      }
    }
  } catch (e) {
    // Errors inside step() are already recorded; anything else must never pass silently.
    const msg = String(e && e.message || e).slice(0, 1500);
    if (!rec.problems.some((p) => p.includes(msg.slice(0, 200)))) rec.problems.push(`harness: ${msg}`);
  }
  finally {
    if (!rec.steps.verify && !rec.problems.length) rec.problems.push('harness: verify never ran');
    if (!args.keep) for (const f of placed) fs.rmSync(f, { force: true });
    rec.ok = rec.problems.length === 0;
    rec.seconds = Math.round((Date.now() - t0) / 1000);
  }
  return rec;
}

const stop = await startApps([...new Set(cases.map((c) => readJSON(path.join(CASES_DIR, c, 'case.json')).app))]);
try {
  for (const lang of langs) {
    for (const name of cases) {
      process.stdout.write(`▶ ${lang} ${name} … `);
      const r = await runCase(name, lang);
      results.push(r);
      console.log(`${r.ok ? 'ok' : 'FAIL'} (${r.seconds}s)`);
      for (const p of r.problems) console.log('   - ' + p.split('\n').join('\n     '));
    }
  }
} finally { stop(); }

const failed = results.filter((r) => !r.ok);
fs.mkdirSync(path.join(ROOT, 'evals', 'results'), { recursive: true });
const outFile = path.join(ROOT, 'evals', 'results', `results-${langs.join('-')}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
fs.writeFileSync(outFile, JSON.stringify({ when: new Date().toISOString(), results }, null, 2));
console.log(`\n${results.length - failed.length}/${results.length} cases passed. Report: ${path.relative(ROOT, outFile)}`);
process.exit(failed.length ? 1 : 0);
