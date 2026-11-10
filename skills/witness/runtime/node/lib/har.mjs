// Reads the HAR saved by `playwright codegen --save-har` into normalized calls.
import { readJSON, exists, templatePath, queryKeys, MUTATING } from './util.mjs';

export function readHar(file, origin) {
  if (!file || !exists(file)) return null;
  const har = readJSON(file);
  const entries = (har.log && har.log.entries) || [];
  const out = [];
  for (const e of entries) {
    let u;
    try { u = new URL(e.request.url); } catch { continue; }
    const type = e._resourceType || (e.response && /json/.test(e.response.content?.mimeType || '') ? 'fetch' : 'other');
    if (!['document', 'xhr', 'fetch'].includes(type) && !MUTATING.has(e.request.method)) continue;
    out.push({
      method: e.request.method,
      path: u.pathname + u.search,
      template: templatePath(u.pathname),
      queryKeys: queryKeys(u.pathname + u.search),
      status: e.response ? e.response.status : undefined,
      resourceType: type,
      sameOrigin: !origin || u.origin === origin,
      origin: u.origin,
      startedDateTime: e.startedDateTime,
      responseExcerpt: (e.response?.content?.text || '').slice(0, 300),
    });
  }
  out.sort((a, b) => String(a.startedDateTime).localeCompare(String(b.startedDateTime)));
  return out;
}

/** Most common document origin in the HAR (the app under test). */
export function harOrigin(calls) {
  const counts = new Map();
  for (const c of calls || []) if (c.resourceType === 'document') counts.set(c.origin, (counts.get(c.origin) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
}
