'use strict';
// Minimal zero-dependency web framework shared by the demo apps.
// Demo apps are intentionally small, in-memory, and reset on restart.
// TEST_MODE=1 enables POST /__test/reset (used by evals to restore seed data).

const http = require('http');
const crypto = require('crypto');

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(data);
}

function html(res, status, body) {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function redirect(res, location) {
  res.writeHead(302, { location });
  res.end();
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 1e6) req.destroy(); });
    req.on('end', () => {
      if (!raw) return resolve({});
      const type = req.headers['content-type'] || '';
      try {
        if (type.includes('application/json')) return resolve(JSON.parse(raw));
        if (type.includes('application/x-www-form-urlencoded')) return resolve(Object.fromEntries(new URLSearchParams(raw)));
      } catch { /* fall through */ }
      resolve({});
    });
  });
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const BASE_CSS = `
:root { --fg:#1d1d1f; --muted:#5f5e5a; --line:#d3d1c7; --bg:#fbfaf7; --card:#fff; --accent:#534ab7; --danger:#a32d2d; --ok:#0f6e56; }
* { box-sizing: border-box; }
body { margin:0; font: 16px/1.5 system-ui, sans-serif; color:var(--fg); background:var(--bg); }
header { display:flex; gap:16px; align-items:center; padding:12px 20px; border-bottom:1px solid var(--line); background:var(--card); }
header .brand { font-weight:600; margin-right:auto; }
header a { color:var(--accent); text-decoration:none; }
main { max-width: 920px; margin: 24px auto; padding: 0 16px; }
table { width:100%; border-collapse: collapse; background:var(--card); }
th, td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--line); }
button { font: inherit; padding:6px 12px; border-radius:6px; border:1px solid var(--line); background:var(--card); cursor:pointer; }
button.primary { background:var(--accent); color:#fff; border-color:var(--accent); }
button:disabled { opacity:.5; cursor:not-allowed; }
input, select { font: inherit; padding:6px 8px; border:1px solid var(--line); border-radius:6px; }
label { display:block; margin: 10px 0 4px; }
.field-error { color: var(--danger); font-size: 14px; margin-top:4px; }
.toast { position: fixed; top: 16px; right: 16px; background:#04342c; color:#fff; padding:10px 14px; border-radius:8px; }
.muted { color: var(--muted); }
.card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:16px; margin-bottom:16px; }
ul.plain { list-style:none; padding:0; margin:0; }
ul.plain li { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:12px 16px; margin-bottom:10px; display:flex; gap:12px; align-items:center; }
ul.plain li .grow { flex:1; }
.badge { font-size:13px; padding:2px 8px; border-radius:999px; background:#faeeda; color:#633806; }
.badge.bad { background:#fcebeb; color:#791f1f; }
.badge.good { background:#e1f5ee; color:#085041; }
`;

// Client-side helpers injected into every page.
const CLIENT_JS = `
window.api = async function api(method, url, body) {
  const res = await fetch(url, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  let data = null; try { data = await res.json(); } catch {}
  return { ok: res.ok, status: res.status, data: data || {} };
};
window.toast = function toast(message, delayMs) {
  setTimeout(() => {
    const old = document.querySelector('.toast'); if (old) old.remove();
    const t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); t.textContent = message;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 4000);
  }, delayMs || 0);
};
window.money = (cents) => '$' + (cents / 100).toFixed(2);
window.esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
`;

function layout({ title, brand, nav = [], user, body, script = '', extraHead = '' }) {
  const navHtml = nav.map((n) => `<a href="${n.href}">${escapeHtml(n.label)}</a>`).join('');
  const userHtml = user
    ? `<span class="muted">${escapeHtml(user.name)}</span><form method="post" action="/logout" style="display:inline"><button type="submit">Sign out</button></form>`
    : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} · ${escapeHtml(brand)}</title><style>${BASE_CSS}</style>${extraHead}</head>
<body><header><span class="brand">${escapeHtml(brand)}</span><nav style="display:flex;gap:14px">${navHtml}</nav>${userHtml}</header>
<main>${body}</main><script>${CLIENT_JS}</script><script>${script}</script></body></html>`;
}

/**
 * createServer({ name, seed, users, routes })
 *  - seed(): returns a fresh in-memory state
 *  - routes: array of [method, pattern, handler(ctx)] where pattern supports :params
 *  - handler ctx: { req, res, state, user, params, query, body, cookies, login(userId), logout() }
 */
function createServer({ name, seed, routes, loginPath = '/login' }) {
  let state = seed();
  let sessions = new Map();

  const compiled = routes.map(([method, pattern, handler, opts = {}]) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:[a-zA-Z]+/g, (m) => { keys.push(m.slice(1)); return '([^/]+)'; }) + '/?$');
    return { method, re, keys, handler, opts };
  });

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (process.env.TEST_MODE === '1' && req.method === 'POST' && url.pathname === '/__test/reset') {
        state = seed();
        sessions = new Map();
        return json(res, 200, { ok: true });
      }
      const cookies = parseCookies(req);
      const userId = sessions.get(cookies.sid);
      const user = userId ? state.users.find((u) => u.id === userId) : null;
      for (const r of compiled) {
        if (r.method !== req.method) continue;
        const m = url.pathname.match(r.re);
        if (!m) continue;
        const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
        if (r.opts.auth && !user) {
          if (url.pathname.startsWith('/api/')) return json(res, 401, { error: 'Sign in required' });
          return redirect(res, loginPath + '?next=' + encodeURIComponent(url.pathname));
        }
        if (r.opts.role && (!user || user.role !== r.opts.role)) {
          if (url.pathname.startsWith('/api/')) return json(res, 403, { error: 'Not allowed' });
          return html(res, 403, '<h1>Not allowed</h1>');
        }
        const body = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) ? await readBody(req) : {};
        const ctx = {
          req, res, state, user, params, body, cookies,
          query: Object.fromEntries(url.searchParams),
          login(id) {
            const sid = crypto.randomBytes(16).toString('hex');
            sessions.set(sid, id);
            res.setHeader('set-cookie', `sid=${sid}; Path=/; HttpOnly; SameSite=Lax`);
          },
          logout() {
            sessions.delete(cookies.sid);
            res.setHeader('set-cookie', 'sid=; Path=/; Max-Age=0');
          },
        };
        return await r.handler(ctx);
      }
      if (url.pathname.startsWith('/api/')) return json(res, 404, { error: 'Not found' });
      html(res, 404, '<h1>Not found</h1>');
    } catch (err) {
      console.error(err);
      json(res, 500, { error: 'Server error' });
    }
  });
  return server;
}

function nextId(list) {
  return list.reduce((m, x) => Math.max(m, x.id), 0) + 1;
}

function listen(server, defaultPort, name) {
  const port = Number(process.env.PORT || defaultPort);
  server.listen(port, () => console.log(`${name} listening on http://localhost:${port}${process.env.TEST_MODE === '1' ? ' (TEST_MODE)' : ''}`));
  return server;
}

/** Standard sign-in routes shared by all demo apps. */
function authRoutes({ brand, home }) {
  const page = (ctx) => html(ctx.res, 200, layout({
    title: 'Sign in', brand, body: `
<div class="card" style="max-width:420px;margin:40px auto">
  <h1>Sign in</h1>
  <form id="login-form" novalidate>
    <label for="email">Email</label><input id="email" name="email" type="email" autocomplete="username" style="width:100%">
    <label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" style="width:100%">
    <p id="login-error" role="alert" class="field-error"></p>
    <button class="primary" type="submit">Sign in</button>
  </form>
</div>`,
    script: `
document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = await api('POST', '/api/login', { email: document.getElementById('email').value, password: document.getElementById('password').value });
  if (!r.ok) { document.getElementById('login-error').textContent = r.data.error || 'Sign in failed'; return; }
  const next = new URLSearchParams(location.search).get('next');
  location.href = next || r.data.home || ${JSON.stringify(home)};
});`,
  }));
  return [
    ['GET', '/login', page],
    ['POST', '/api/login', (ctx) => {
      const u = ctx.state.users.find((x) => x.email === String(ctx.body.email || '').toLowerCase().trim());
      if (!u || u.password !== ctx.body.password) return json(ctx.res, 401, { error: 'Invalid email or password' });
      ctx.login(u.id);
      return json(ctx.res, 200, { id: u.id, name: u.name, role: u.role, home: u.home || home });
    }],
    ['POST', '/logout', (ctx) => { ctx.logout(); return redirect(ctx.res, '/login'); }],
    ['GET', '/api/me', (ctx) => ctx.user ? json(ctx.res, 200, { id: ctx.user.id, name: ctx.user.name, role: ctx.user.role }) : json(ctx.res, 401, { error: 'Sign in required' })],
  ];
}

module.exports = { createServer, layout, json, html, redirect, escapeHtml, nextId, listen, authRoutes };
