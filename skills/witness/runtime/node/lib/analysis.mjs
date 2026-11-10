// Turns raw-replay evidence into facts the agent can act on:
// step classification, verified locator candidates, checkpoint candidates, stability,
// divergence from the recording (state-dependent data), overlays, dialogs, time-dependent text.
//
// Pure functions over evidence JSON so the Python runtime can share test vectors.
import { templatePath, queryKeys, statusClass, MUTATING, digitsMasked, regexFor } from './util.mjs';

const CLICKISH = new Set(['click', 'dblclick', 'tap', 'hover']);
const INPUTISH = new Set(['fill', 'type', 'pressSequentially', 'clear', 'press']);
// Preference order for locators. A role without an accessible name is weak (e.g. getByRole('strong')).
const CANDIDATE_ORDER = ['role', 'label', 'placeholder', 'testid', 'scoped-role', 'role-unnamed', 'text'];
const TIME_RE = /\b(\d+\s*(?:second|minute|hour|day|week|month|year)s?|today|tomorrow|yesterday|overdue|ago|due\b|\d{1,2}:\d{2}(?::\d{2})?|(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}|\d{4}-\d{2}-\d{2})/i;

export function actionClass(method) {
  if (['goto', 'reload', 'goBack', 'goForward'].includes(method)) return 'nav';
  if (['click', 'dblclick', 'tap'].includes(method)) return 'click';
  if (['fill', 'type', 'pressSequentially', 'clear'].includes(method)) return 'input';
  if (method === 'press') return 'key';
  if (['check', 'uncheck', 'setChecked'].includes(method)) return 'check';
  if (method === 'selectOption') return 'select';
  if (method === 'setInputFiles') return 'file';
  if (method === 'hover') return 'hover';
  if (method === 'dragTo') return 'drag';
  return 'other';
}

function stepValue(step) {
  const a = Array.isArray(step.args) ? step.args : [];
  if (['fill', 'type', 'pressSequentially', 'press', 'selectOption'].includes(step.method)) return a[0];
  if (step.method === 'goto') return a[0];
  return undefined;
}

function sameTarget(a, b) {
  if (!a || !b) return false;
  if (a.selector && b.selector && a.selector === b.selector) return true;
  if (a.role && b.role && a.name && b.name) return a.role === b.role && a.name.toLowerCase() === b.name.toLowerCase();
  if (a.attrs?.testId && b.attrs?.testId) return a.attrs.testId === b.attrs.testId;
  return false;
}

export function bestCandidate(target) {
  const list = (target && target.candidates) || [];
  // Works for both runtimes' code strings: name: 'X' (JS) and name="X" (Python).
  const kindOf = (x) => (x.kind === 'role' && !/name[:=]/.test(x.code) ? 'role-unnamed' : x.kind);
  for (const kind of CANDIDATE_ORDER) {
    const c = list.find((x) => kindOf(x) === kind && x.matchesTarget);
    if (c) return { ...c, kind: kindOf(c) };
  }
  return null;
}

function requestsOf(ev, stepIndex) {
  return (ev.requests || []).filter((r) => r.step === stepIndex);
}

function parseLine(line) {
  const m = String(line).match(/^-\s+([a-zA-Z]+)(?:\s+"((?:[^"\\]|\\.)*)")?((?:\s*\[[^\]]*\])*)\s*(?::\s*(.*))?$/);
  if (!m) return { role: null, name: null, text: null };
  return { role: m[1], name: m[2] ? m[2].replace(/\\"/g, '"') : null, text: m[4] ?? null };
}

/** Classify steps of one evidence run. */
export function classifySteps(ev) {
  const steps = ev.steps || [];
  const out = steps.map((s) => {
    const reqs = requestsOf(ev, s.index);
    const dialogs = (ev.dialogs || []).filter((d) => d.step === s.index);
    const urlChanged = s.urlBefore !== undefined && s.urlAfter !== undefined && s.urlBefore !== s.urlAfter;
    const hasDomEffect = (s.added && s.added.length) || (s.removed && s.removed.length);
    const effectful = !!(hasDomEffect || urlChanged || reqs.length || dialogs.length);
    const cls = actionClass(s.method);
    const kind = cls === 'nav' || !CLICKISH.has(s.method) || effectful ? 'action' : 'observation';
    return {
      index: s.index, method: s.method, class: cls, kind, value: stepValue(s),
      recordedLocator: s.target?.locator || (s.on === 'page' ? 'page' : null),
      target: s.target ? { role: s.target.role ?? null, name: s.target.name ?? null, ariaLine: s.target.ariaLine ?? null,
        testId: s.target.attrs?.testId ?? null, label: s.target.attrs?.label ?? null, containerRole: s.target.attrs?.containerRole ?? null,
        containerText: s.target.attrs?.containerText ?? null, tag: s.target.attrs?.tag ?? null, text: s.target.text ?? null } : null,
      locator: bestCandidate(s.target),
      candidates: (s.target?.candidates || []).map((c) => ({ kind: c.kind, code: c.code, count: c.count, matchesTarget: !!c.matchesTarget })),
      effects: {
        added: (s.added || []).length, removed: (s.removed || []).length, urlChanged,
        urlAfter: s.urlAfter, requests: reqs.map((r) => `${r.method} ${templatePath(r.path)} ${r.status ?? r.failure ?? '?'}`),
        dialogs: dialogs.map((d) => `${d.type}: ${d.message}`),
      },
      settleMs: s.settleMs ?? null,
      delayedEffect: (s.settleMs || 0) >= 250,
      error: s.error || null,
      optional: null,
    };
  });

  // Optional steps: things a clean test need not reproduce literally.
  for (let i = 0; i < out.length; i++) {
    const s = out[i], next = out[i + 1], raw = steps[i], rawNext = steps[i + 1];
    // Precedence matters: a click that only focuses a field is not the user "looking" at something.
    if (s.class === 'click' && next && ['input', 'key'].includes(next.class) && sameTarget(raw.target, rawNext.target) && !requestsOf(ev, s.index).length && !s.effects.urlChanged) {
      s.optional = 'focus-before-input';
      continue;
    }
    if (s.kind === 'observation') { s.optional = 'observation'; continue; }
    if (s.class === 'input' && next && next.class === 'input' && sameTarget(raw.target, rawNext.target)) {
      s.optional = 'superseded-input';
      continue;
    }
    const removedDialog = (raw.removed || []).some((l) => /^-\s+dialog\b/.test(l.line));
    if (s.class === 'click' && s.target?.containerRole === 'dialog' && removedDialog && !requestsOf(ev, s.index).some((r) => r.resourceType !== 'document')) {
      s.optional = 'overlay-dismiss';
    }
  }
  return out;
}

/** Checkpoint candidates: observable changes caused by actions. Non-vacuous by construction. */
export function checkpointCandidates(ev, classified) {
  const steps = ev.steps || [];
  const finalSnap = ev.final?.snapshot || steps[steps.length - 1]?.snapshotAfter || '';
  const finalLines = new Set(finalSnap.split('\n').map((l) => l.trim()).filter(Boolean));
  // "Looking" clicks: clicks with no effect that are not just focusing a field before typing.
  // Their target text (or, if the target never resolved, the recorded locator) marks what the user checked.
  const observed = classified.filter((s) => s.optional === 'observation').map((s) => ({
    index: s.index, ariaLine: s.target?.ariaLine || null, name: s.target?.name || null, text: s.target?.text || null, arg: locatorArg(s.recordedLocator),
  }));
  // Exact matches only: looking at "Borrowed The Left Hand…" must not mark every "Borrow" button as attended.
  const isAttended = (stepIndex, line, text) => observed.some((o) => o.index > stepIndex && (
    (o.ariaLine && o.ariaLine === line) || (text && (text === o.name || text === o.text)) || (o.arg && o.arg.length >= 3 && text && text.includes(o.arg))));
  const out = [];
  for (const s of steps) {
    const c = classified[s.index];
    if (!c || c.kind !== 'action' || c.optional) continue;
    const ownLine = s.target?.ariaLine;
    for (const a of s.added || []) {
      if (c.class === 'input' && ownLine && a.line.startsWith(ownLine.split(':')[0])) continue; // the field's own new value
      if (/^-\s+(img|separator|generic)\b/.test(a.line)) continue;
      const p = parseLine(a.line);
      if (!p.role) continue;
      const text = p.name || p.text || '';
      if (!text && !['dialog', 'row', 'listitem'].includes(p.role)) continue; // empty live regions are noise
      out.push({
        step: s.index, type: 'appeared', line: a.line, path: a.path, role: p.role, name: p.name, text: p.text, onLoad: c.class === 'nav',
        inFinal: finalLines.has(a.line),
        attended: isAttended(s.index, a.line, text),
        settleMs: s.settleMs ?? null,
        timeLike: TIME_RE.test(a.line),
      });
    }
    for (const r of s.removed || []) {
      const p = parseLine(r.line);
      if (!p.role || ['img', 'separator', 'generic'].includes(p.role)) continue;
      if (c.class === 'input' && ownLine && r.line.startsWith(ownLine.split(':')[0])) continue;
      if (!['row', 'listitem', 'dialog', 'alert', 'status', 'heading', 'button', 'link', 'cell'].includes(p.role) && !(p.name || p.text)) continue;
      out.push({ step: s.index, type: 'disappeared', line: r.line, path: r.path, role: p.role, name: p.name, text: p.text, inFinal: false, attended: false, settleMs: s.settleMs ?? null, timeLike: TIME_RE.test(r.line) });
    }
    if (c.class !== 'nav' && s.urlBefore !== s.urlAfter && s.urlAfter) {
      out.push({ step: s.index, type: 'url', line: templatePath(new URL(s.urlAfter).pathname), urlAfter: s.urlAfter, inFinal: s.urlAfter === ev.final?.url, attended: false, settleMs: s.settleMs ?? null, timeLike: false });
    }
    for (const r of requestsOf(ev, s.index)) {
      if (!MUTATING.has(r.method) || !r.sameOrigin) continue;
      out.push({ step: s.index, type: 'request', line: `${r.method} ${templatePath(r.path)} → ${r.status ?? r.failure}`, method: r.method, template: templatePath(r.path), status: r.status ?? null, inFinal: false, attended: false, settleMs: null, timeLike: false });
    }
  }
  return out.map((c, i) => ({ id: `c${i + 1}`, ...c }));
}

/** Mark candidates stable / dynamic / unstable by comparing with other passing runs. */
export function markStability(candidates, otherRuns) {
  if (!otherRuns.length) return candidates.map((c) => ({ ...c, stability: 'unknown' }));
  return candidates.map((c) => {
    let stable = true, dynamic = false;
    for (const ev of otherRuns) {
      const s = (ev.steps || [])[c.step];
      if (!s) { stable = false; continue; }
      if (c.type === 'appeared' || c.type === 'disappeared') {
        const pool = (c.type === 'appeared' ? s.added : s.removed) || [];
        if (pool.some((x) => x.line === c.line)) continue;
        if (pool.some((x) => digitsMasked(x.line) === digitsMasked(c.line))) { dynamic = true; continue; }
        stable = false;
      } else if (c.type === 'url') {
        if (!s.urlAfter || templatePath(new URL(s.urlAfter).pathname) !== c.line) stable = false;
        else if (s.urlAfter !== c.urlAfter) dynamic = true;
      } else if (c.type === 'request') {
        const ok = (ev.requests || []).some((r) => r.step === c.step && r.method === c.method && templatePath(r.path) === c.template && statusClass(r.status) === statusClass(c.status));
        if (!ok) stable = false;
      }
    }
    const stability = !stable ? 'unstable' : dynamic ? 'dynamic' : 'stable';
    const out = { ...c, stability };
    if (dynamic && (c.type === 'appeared' || c.type === 'disappeared')) out.suggestedRegex = regexFor(c.name || c.text || c.line);
    return out;
  });
}

/** The text argument of a recorded getByText(...) locator, e.g. getByText('Coupon applied') → Coupon applied. */
function locatorArg(s) {
  const m = String(s || '').match(/get_?[bB]y_?[tT]ext\((['"])(.+?)\1/);
  return m ? m[2] : null;
}

export function scoreCandidate(c) {
  let s = 0;
  if (c.onLoad && !c.attended) s -= 2; // page chrome that merely appeared on load
  if (c.attended) s += 3;
  if (['status', 'alert'].includes(c.role)) s += 2;
  if (c.type === 'url') s += 2;
  if (c.role === 'heading') s += 1;
  if (c.inFinal) s += 1;
  if (c.type === 'request' && statusClass(c.status) === '2xx') s += 1;
  if (c.type === 'request') s -= 1; // supporting evidence, not a primary outcome
  if (c.stability === 'dynamic') s -= 1;
  if (c.stability === 'unstable') s -= 5;
  if (c.timeLike) s -= 1;
  return s;
}

/**
 * Weighted longest-common-subsequence alignment. weight(a[i]) lets required items win over optional
 * ones (e.g. a test's fill should align with the recorded final value, not a superseded typo).
 */
function lcs(a, b, eq, weight = () => 1) {
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const skip = Math.max(dp[i + 1][j], dp[i][j + 1]);
      dp[i][j] = eq(a[i], b[j]) ? Math.max(skip, dp[i + 1][j + 1] + weight(a[i])) : skip;
    }
  }
  const pairs = [], onlyA = [], onlyB = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (eq(a[i], b[j]) && dp[i][j] === dp[i + 1][j + 1] + weight(a[i])) { pairs.push([a[i], b[j]]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) onlyA.push(a[i++]);
    else onlyB.push(b[j++]);
  }
  while (i < n) onlyA.push(a[i++]);
  while (j < m) onlyB.push(b[j++]);
  return { pairs, onlyA, onlyB };
}
export { lcs };

export function mutationsOf(ev) {
  return (ev.requests || [])
    .filter((r) => r.sameOrigin && MUTATING.has(r.method))
    .map((r) => ({ method: r.method, template: templatePath(r.path), status: r.status ?? null, step: r.step, message: r.responseExcerpt || null }));
}

/** Compare the recording (HAR) with the first replay; and each replay with the previous one. */
export function divergences(harCalls, runs, origin) {
  const out = [];
  if (harCalls && runs[0]) {
    const recorded = harCalls.filter((c) => (!origin || c.origin === origin) && MUTATING.has(c.method))
      .map((c) => ({ method: c.method, template: c.template, status: c.status, message: c.responseExcerpt }));
    const replay = mutationsOf(runs[0]);
    const { pairs, onlyA, onlyB } = lcs(recorded, replay, (a, b) => a.method === b.method && a.template === b.template);
    for (const [r, p] of pairs) {
      if (statusClass(r.status) === '2xx' && statusClass(p.status) !== '2xx') {
        out.push({ kind: 'state_dependent', against: 'recording', method: p.method, template: p.template, recordedStatus: r.status, replayStatus: p.status, step: p.step, message: p.message });
      } else if (statusClass(r.status) !== statusClass(p.status)) {
        out.push({ kind: 'status_changed', against: 'recording', method: p.method, template: p.template, recordedStatus: r.status, replayStatus: p.status, step: p.step, message: p.message });
      }
    }
    for (const r of onlyA) out.push({ kind: 'missing_request', against: 'recording', method: r.method, template: r.template, recordedStatus: r.status });
    for (const p of onlyB) out.push({ kind: 'extra_request', against: 'recording', method: p.method, template: p.template, replayStatus: p.status, step: p.step });

    const recordedReads = new Set(harCalls.filter((c) => (!origin || c.origin === origin) && c.method === 'GET' && ['xhr', 'fetch'].includes(c.resourceType)).map((c) => `${c.template}?${c.queryKeys}`));
    const replayReads = new Set((runs[0].requests || []).filter((r) => r.sameOrigin && r.method === 'GET' && ['xhr', 'fetch'].includes(r.resourceType)).map((r) => `${templatePath(r.path)}?${queryKeys(r.path)}`));
    for (const k of recordedReads) if (!replayReads.has(k)) out.push({ kind: 'missing_read', against: 'recording', method: 'GET', template: k.replace(/\?$/, '') });
  }
  for (let i = 1; i < runs.length; i++) {
    const prev = mutationsOf(runs[i - 1]), cur = mutationsOf(runs[i]);
    const { pairs } = lcs(prev, cur, (a, b) => a.method === b.method && a.template === b.template);
    for (const [a, b] of pairs) {
      if (statusClass(a.status) === '2xx' && statusClass(b.status) !== '2xx') {
        out.push({ kind: 'state_dependent', against: `replay ${i}`, method: b.method, template: b.template, recordedStatus: a.status, replayStatus: b.status, step: b.step, message: b.message });
      }
    }
  }
  return out;
}

export function overlays(ev, classified) {
  const out = [];
  for (const s of ev.steps || []) {
    const c = classified[s.index];
    if (c?.optional === 'overlay-dismiss') {
      const d = (s.removed || []).find((l) => /^-\s+dialog\b/.test(l.line));
      out.push({ dialog: d ? d.line : null, dismissedAt: s.index, using: c.locator?.code || c.recordedLocator });
    }
  }
  return out;
}

export function apiHints(ev) {
  return (ev.requests || [])
    .filter((r) => r.sameOrigin && MUTATING.has(r.method))
    .map((r) => ({ step: r.step, method: r.method, path: r.path, template: templatePath(r.path), status: r.status ?? null, requestBody: r.postData || null, responseExcerpt: r.responseExcerpt || null }));
}

/** Build the full analysis from N observe runs of the same recording. */
export function buildAnalysis({ flow, runs, harCalls, origin }) {
  const statuses = runs.map((ev, i) => {
    const failed = (ev.steps || []).find((s) => s.error);
    return { run: i + 1, status: ev.status, error: ev.error || null, failedStep: failed ? failed.index : null };
  });
  const passing = runs.filter((ev) => ev.status === 'passed');
  const baseline = passing[passing.length - 1] || runs[0];
  const classified = classifySteps(baseline);
  let candidates = checkpointCandidates(baseline, classified);
  candidates = markStability(candidates, passing.filter((r) => r !== baseline));
  candidates = candidates.map((c) => ({ ...c, score: scoreCandidate(c) })).sort((a, b) => b.score - a.score || a.step - b.step);
  const div = divergences(harCalls, runs, origin);
  const dialogs = (baseline.dialogs || []).map((d) => ({ ...d }));
  const nav = (baseline.requests || []).filter((r) => r.sameOrigin && r.resourceType === 'document').map((r) => templatePath(r.path));
  return {
    version: 1,
    flow,
    analyzedAt: new Date().toISOString(),
    runs: statuses,
    repeatable: runs.length > 1 && runs.every((r) => r.status === 'passed') && !div.some((d) => d.kind === 'state_dependent'),
    steps: classified,
    checkpointCandidates: candidates,
    divergences: div,
    dialogs,
    overlays: overlays(baseline, classified),
    timeDependent: candidates.filter((c) => c.timeLike).map((c) => c.id),
    api: apiHints(baseline),
    baseline: {
      actions: classified.filter((s) => s.kind === 'action').map((s) => ({ index: s.index, class: s.class, role: s.target?.role, name: s.target?.name, testId: s.target?.testId, label: s.target?.label, value: s.value, optional: s.optional, nav: s.class === 'nav' ? templatePath(String(s.value || '').replace(/^https?:\/\/[^/]+/, '')) : null })),
      navigation: dedupe(nav),
      mutations: mutationsOf(baseline).map(({ method, template, status }) => ({ method, template, statusClass: statusClass(status) })),
    },
  };
}

function dedupe(list) { return list.filter((x, i) => i === 0 || x !== list[i - 1]); }

/** Compact markdown for the agent's context. Full detail stays in analysis.json. */
export function analysisSummary(a) {
  const L = [];
  L.push(`# Witness analysis: ${a.flow}`);
  L.push('');
  L.push(`Runs: ${a.runs.map((r) => `#${r.run} ${r.status}${r.failedStep !== null ? ` (failed at step ${r.failedStep})` : ''}`).join(', ')}. Repeatable${a.kind === 'prepared' ? '' : ' as recorded'}: ${a.repeatable ? 'yes' : 'no'}.`);
  const errs = a.runs.filter((r) => r.error);
  for (const r of errs) L.push(`- run ${r.run} error: ${String(r.error).split('\n')[0]}`);
  if (a.divergences.length) {
    L.push('', '## Divergences');
    for (const d of a.divergences) {
      if (d.kind === 'state_dependent') L.push(`- STATE-DEPENDENT (vs ${d.against}): ${d.method} ${d.template} was ${d.recordedStatus}, now ${d.replayStatus}${d.message ? ` — ${d.message.slice(0, 120)}` : ''} (step ${d.step})`);
      else if (d.kind === 'missing_request') L.push(`- MISSING (vs ${d.against}): ${d.method} ${d.template} (recorded ${d.recordedStatus}) never happened in the replay`);
      else if (d.kind === 'extra_request') L.push(`- EXTRA (vs ${d.against}): ${d.method} ${d.template} → ${d.replayStatus} (step ${d.step})`);
      else if (d.kind === 'missing_read') L.push(`- MISSING READ: GET ${d.template} happened while recording but not in the replay (event-driven UI? try pressSequentially)`);
      else L.push(`- ${d.kind}: ${d.method} ${d.template} ${d.recordedStatus} → ${d.replayStatus}`);
    }
  }
  L.push('', '## Steps');
  for (const s of a.steps) {
    const tgt = s.target ? `${s.target.role || s.target.tag || ''}${s.target.name ? ` "${s.target.name}"` : ''}` : '';
    const loc = s.locator ? s.locator.code : (s.recordedLocator || '');
    const eff = [s.effects.added ? `+${s.effects.added}` : '', s.effects.removed ? `-${s.effects.removed}` : '', s.effects.urlChanged ? 'url' : '', ...s.effects.requests, ...s.effects.dialogs].filter(Boolean).join(', ');
    L.push(`${s.index}. ${s.method}${s.value !== undefined ? ` ${JSON.stringify(s.value)}` : ''} ${tgt} — ${s.kind}${s.optional ? ` (optional: ${s.optional})` : ''}${eff ? ` — effects: ${eff}` : ''}${s.delayedEffect ? ` — settled after ${s.settleMs}ms` : ''}${loc && s.class !== 'nav' ? `\n   locator: ${loc}${s.locator ? '' : ' (no verified unique candidate)'}` : ''}${s.error ? `\n   ERROR: ${s.error}` : ''}`);
  }
  L.push('', '## Checkpoint candidates (best first)');
  for (const c of a.checkpointCandidates.slice(0, 12)) {
    const flags = [c.stability, c.attended ? 'attended' : '', c.inFinal ? 'final' : '', c.timeLike ? 'time-like' : '', c.suggestedRegex ? `regex /${c.suggestedRegex}/` : ''].filter(Boolean).join(', ');
    L.push(`- ${c.id} [score ${c.score}] step ${c.step} ${c.type}: ${c.line}${c.path && c.path.length ? `  (in: ${c.path.slice(-2).join(' > ')})` : ''} — ${flags}`);
  }
  if (a.checkpointCandidates.length > 12) L.push(`- …${a.checkpointCandidates.length - 12} more in analysis.json`);
  if (a.overlays.length) { L.push('', '## Overlays'); for (const o of a.overlays) L.push(`- ${o.dialog} dismissed at step ${o.dismissedAt} → use page.addLocatorHandler`); }
  if (a.dialogs.length) { L.push('', '## Native dialogs'); for (const d of a.dialogs) L.push(`- step ${d.step}: ${d.type} "${d.message}" (check the recording's handler: codegen dismisses by default)`); }
  if (a.api.length) { L.push('', '## App API calls observed (for test data provisioning)'); for (const x of a.api.slice(0, 8)) L.push(`- ${x.method} ${x.template} → ${x.status}${x.requestBody ? ` body ${x.requestBody.slice(0, 120)}` : ''}`); }
  const next = nextSteps(a);
  if (next.length) { L.push('', '## Next'); next.forEach((n, i) => L.push(`${i + 1}. ${n}`)); }
  return L.join('\n') + '\n';
}

/** Concrete follow-ups derived from the findings (see references/data.md and references/locators.md). */
export function nextSteps(a) {
  const out = [];
  const kinds = new Set(a.divergences.map((d) => d.kind));
  const failed = a.runs.some((r) => r.status !== 'passed');
  if (kinds.has('state_dependent')) {
    out.push('The recording consumed or created data, so replays now take a different path. Write prepared.spec.ts next to raw.spec.ts: the same steps, with only data made fresh per run (unique values, or setup through the app API listed above). Then run `witness analyze ' + a.flow + ' --spec .witness/recordings/' + a.flow + '/prepared.spec.ts`.');
  }
  if (kinds.has('missing_read')) out.push('A read request from the recording never happened in the replay: the UI probably reacts to key events, not to fill(). Use pressSequentially() for that input in prepared.spec.ts.');
  if (kinds.has('missing_request') && a.dialogs.length) out.push('A call from the recording is missing and a native dialog was involved: codegen records dialog.dismiss(), but the user accepted it. Accept the dialog in prepared.spec.ts.');
  else if (kinds.has('missing_request')) out.push('A call from the recording never happened in the replay; check the failing step and any dialogs.');
  if (a.overlays.length) out.push('Dismiss overlays with page.addLocatorHandler() instead of a recorded click (they may not appear every time).');
  if (a.timeDependent.length) out.push('Some candidate text depends on the current date or time; control the clock (page.clock) or assert with a regex.');
  if (failed && !kinds.has('state_dependent') && !kinds.has('missing_read')) out.push('A replay failed without a data divergence; look at the failing step error before generating anything.');
  if (!failed && !kinds.has('state_dependent')) out.push('The flow replays cleanly. Generate the test from the steps and candidates above, then run `witness verify ' + a.flow + ' --spec <test file>`.');
  return out;
}
