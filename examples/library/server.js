'use strict';
// Library demo app (lending). Edge cases exercised by Witness evals:
//  - borrow + return is net-neutral (a control case: the recording is repeatable as-is)
//  - "Due in N days" / "Overdue by N days" computed in the browser from Date.now() (time-dependent text)
//  - tabs (All / Available / On loan) and pagination
//  - repeated "Borrow" buttons per row (needs scoping)
//  - role-based UI: members borrow, librarians manage the catalog
//  - limits and conflicts: 3 active loans max, no copies left, can't delete a book on loan
const { createServer, layout, json, html, nextId, listen, authRoutes } = require('../_shared/mini');

const BRAND = 'Cedar Public Library';
const DAY = 86400000;

function seed() {
  return {
    users: [
      { id: 1, email: 'lib@library.test', password: process.env.LIBRARY_LIBRARIAN_PASSWORD || 'lib-pass', name: 'Lee Librarian', role: 'librarian', home: '/books' },
      { id: 2, email: 'maya@library.test', password: process.env.LIBRARY_MEMBER_PASSWORD || 'maya-pass', name: 'Maya Chen', role: 'member', home: '/books' },
    ],
    books: [
      { id: 1, title: 'Dune', author: 'Frank Herbert', isbn: '9780441013593', copies: 2 },
      { id: 2, title: 'The Left Hand of Darkness', author: 'Ursula K. Le Guin', isbn: '9780441478125', copies: 2 },
      { id: 3, title: 'Kindred', author: 'Octavia E. Butler', isbn: '9780807083697', copies: 1 },
      { id: 4, title: 'Piranesi', author: 'Susanna Clarke', isbn: '9781635577808', copies: 1 },
      { id: 5, title: 'The Dispossessed', author: 'Ursula K. Le Guin', isbn: '9780061054884', copies: 1 },
      { id: 6, title: 'Station Eleven', author: 'Emily St. John Mandel', isbn: '9780804172448', copies: 2 },
      { id: 7, title: 'Klara and the Sun', author: 'Kazuo Ishiguro', isbn: '9780593318171', copies: 1 },
    ],
    // Fixed absolute dates: the "Overdue by N days" text changes every day unless the test controls the clock.
    loans: [
      { id: 1, bookId: 1, userId: 2, borrowedAt: '2026-10-18T12:00:00Z', dueAt: '2026-11-01T12:00:00Z', returnedAt: null },
      { id: 2, bookId: 3, userId: 2, borrowedAt: '2026-10-26T12:00:00Z', dueAt: '2026-11-09T12:00:00Z', returnedAt: null },
    ],
  };
}

const activeLoans = (state, bookId) => state.loans.filter((l) => l.bookId === bookId && !l.returnedAt);
const bookView = (state, b) => ({ ...b, available: b.copies - activeLoans(state, b.id).length });

function page(ctx, title, body, script) {
  const nav = [{ href: '/books', label: 'Catalog' }];
  if (ctx.user && ctx.user.role === 'member') nav.push({ href: '/loans', label: 'My loans' });
  return html(ctx.res, 200, layout({ title, brand: BRAND, nav, user: ctx.user, body, script }));
}

function catalogPage(ctx) {
  const isLibrarian = ctx.user.role === 'librarian';
  return page(ctx, 'Catalog', `
<h1>Catalog</h1>
<div role="tablist" aria-label="Filter books" style="display:flex;gap:8px;margin-bottom:12px">
  <button role="tab" data-filter="all" aria-selected="true">All</button>
  <button role="tab" data-filter="available" aria-selected="false">Available</button>
  <button role="tab" data-filter="onloan" aria-selected="false">On loan</button>
</div>
${isLibrarian ? `<div class="card"><h2>Add book</h2><form id="add" novalidate>
  <label for="title">Title</label><input id="title" style="width:100%">
  <label for="author">Author</label><input id="author" style="width:100%">
  <label for="isbn">ISBN</label><input id="isbn">
  <label for="copies">Copies</label><input id="copies" type="number" min="1" value="1">
  <p class="field-error" id="add-error" role="alert"></p>
  <button class="primary" type="submit">Add book</button></form></div>` : ''}
<ul class="plain" id="books" aria-label="Books"></ul>
<nav aria-label="Pagination" style="display:flex;gap:8px;align-items:center">
  <button id="prev">Previous page</button><span id="page-label" class="muted"></span><button id="next">Next page</button>
</nav>`, `
const IS_LIBRARIAN = ${isLibrarian};
let filter = 'all', pageNo = 1;
async function load() {
  const r = await api('GET', '/api/books?filter=' + filter + '&page=' + pageNo);
  document.getElementById('books').innerHTML = r.data.books.map(b => '<li><div class="grow"><strong>' + esc(b.title) + '</strong><div class="muted">' + esc(b.author) + ' · ' + b.available + ' of ' + b.copies + ' available</div></div>'
    + (IS_LIBRARIAN ? '<button data-delete="' + b.id + '">Delete</button>' : (b.available > 0 ? '<button data-borrow="' + b.id + '">Borrow</button>' : '<span class="badge">All copies on loan</span>')) + '</li>').join('');
  document.getElementById('page-label').textContent = 'Page ' + r.data.page + ' of ' + r.data.pages;
  document.getElementById('prev').disabled = r.data.page <= 1;
  document.getElementById('next').disabled = r.data.page >= r.data.pages;
}
document.querySelectorAll('[role=tab]').forEach(t => t.addEventListener('click', () => {
  document.querySelectorAll('[role=tab]').forEach(x => x.setAttribute('aria-selected', String(x === t)));
  filter = t.dataset.filter; pageNo = 1; load();
}));
document.getElementById('prev').onclick = () => { pageNo--; load(); };
document.getElementById('next').onclick = () => { pageNo++; load(); };
document.getElementById('books').addEventListener('click', async (e) => {
  if (e.target.dataset.borrow) {
    const r = await api('POST', '/api/loans', { bookId: Number(e.target.dataset.borrow) });
    toast(r.ok ? 'Borrowed ' + r.data.title + ' · due ' + new Date(r.data.dueAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : r.data.error, 0);
    load();
  }
  if (e.target.dataset.delete) {
    if (!confirm('Delete this book?')) return;
    const r = await api('DELETE', '/api/books/' + e.target.dataset.delete);
    toast(r.ok ? 'Book deleted' : r.data.error, 0); load();
  }
});
const add = document.getElementById('add');
if (add) add.addEventListener('submit', async (e) => {
  e.preventDefault();
  const field = (id) => document.getElementById(id).value;
  const r = await api('POST', '/api/books', { title: field('title'), author: field('author'), isbn: field('isbn'), copies: Number(field('copies')) });
  document.getElementById('add-error').textContent = r.ok ? '' : r.data.error;
  if (r.ok) { toast('Book added', 0); add.reset(); load(); }
});
load();`);
}

function loansPage(ctx) {
  return page(ctx, 'My loans', `
<h1>My loans</h1>
<p id="summary" class="muted"></p>
<ul class="plain" id="loans" aria-label="Loans"></ul>`, `
function dueText(dueAt) {
  const days = Math.round((new Date(dueAt).getTime() - Date.now()) / ${DAY});
  if (days < 0) return '<span class="badge bad">Overdue by ' + (-days) + ' day' + (days === -1 ? '' : 's') + '</span>';
  if (days === 0) return '<span class="badge">Due today</span>';
  return '<span class="badge good">Due in ' + days + ' day' + (days === 1 ? '' : 's') + '</span>';
}
async function load() {
  const r = await api('GET', '/api/loans');
  const loans = r.data.loans;
  document.getElementById('summary').textContent = loans.length + ' of 3 loans in use';
  document.getElementById('loans').innerHTML = loans.map(l => '<li><div class="grow"><strong>' + esc(l.title) + '</strong><div class="muted">Due ' + new Date(l.dueAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }) + '</div></div>' + dueText(l.dueAt) + '<button data-return="' + l.id + '">Return</button></li>').join('') || '<li class="muted">No active loans</li>';
}
document.getElementById('loans').addEventListener('click', async (e) => {
  const id = e.target.dataset.return; if (!id) return;
  const r = await api('POST', '/api/loans/' + id + '/return');
  toast(r.ok ? 'Book returned' : r.data.error, 0); load();
});
load();`);
}

const PAGE_SIZE = 5;

const server = createServer({
  name: BRAND,
  seed,
  routes: [
    ...authRoutes({ brand: BRAND, home: '/books' }),
    ['GET', '/', (ctx) => { ctx.res.writeHead(302, { location: '/books' }); ctx.res.end(); }, { auth: true }],
    ['GET', '/books', catalogPage, { auth: true }],
    ['GET', '/loans', loansPage, { auth: true, role: 'member' }],

    ['GET', '/api/books', (ctx) => {
      let books = ctx.state.books.map((b) => bookView(ctx.state, b));
      if (ctx.query.filter === 'available') books = books.filter((b) => b.available > 0);
      if (ctx.query.filter === 'onloan') books = books.filter((b) => b.available < b.copies);
      const pages = Math.max(1, Math.ceil(books.length / PAGE_SIZE));
      const pageNo = Math.min(pages, Math.max(1, Number(ctx.query.page) || 1));
      return json(ctx.res, 200, { books: books.slice((pageNo - 1) * PAGE_SIZE, pageNo * PAGE_SIZE), page: pageNo, pages, total: books.length });
    }, { auth: true }],
    ['POST', '/api/books', (ctx) => {
      const title = String(ctx.body.title || '').trim();
      const author = String(ctx.body.author || '').trim();
      const isbn = String(ctx.body.isbn || '').replace(/[-\s]/g, '');
      const copies = Number(ctx.body.copies);
      if (!title || !author) return json(ctx.res, 400, { error: 'Title and author are required' });
      if (!/^\d{13}$/.test(isbn)) return json(ctx.res, 400, { error: 'ISBN must be 13 digits' });
      if (!(Number.isInteger(copies) && copies >= 1)) return json(ctx.res, 400, { error: 'Copies must be at least 1' });
      if (ctx.state.books.some((b) => b.isbn === isbn)) return json(ctx.res, 409, { error: 'A book with this ISBN is already in the catalog' });
      const b = { id: nextId(ctx.state.books), title, author, isbn, copies };
      ctx.state.books.push(b);
      return json(ctx.res, 201, b);
    }, { auth: true, role: 'librarian' }],
    ['DELETE', '/api/books/:id', (ctx) => {
      const id = Number(ctx.params.id);
      if (activeLoans(ctx.state, id).length) return json(ctx.res, 409, { error: 'Can’t delete a book that is on loan' });
      const i = ctx.state.books.findIndex((b) => b.id === id);
      if (i < 0) return json(ctx.res, 404, { error: 'Book not found' });
      ctx.state.books.splice(i, 1);
      return json(ctx.res, 200, { ok: true });
    }, { auth: true, role: 'librarian' }],

    ['GET', '/api/loans', (ctx) => json(ctx.res, 200, {
      loans: ctx.state.loans.filter((l) => l.userId === ctx.user.id && !l.returnedAt)
        .map((l) => ({ ...l, title: ctx.state.books.find((b) => b.id === l.bookId).title })),
    }), { auth: true }],
    ['POST', '/api/loans', (ctx) => {
      const b = ctx.state.books.find((x) => x.id === Number(ctx.body.bookId));
      if (!b) return json(ctx.res, 404, { error: 'Book not found' });
      if (ctx.state.loans.filter((l) => l.userId === ctx.user.id && !l.returnedAt).length >= 3) {
        return json(ctx.res, 422, { error: 'Loan limit reached (3 active loans)' });
      }
      if (bookView(ctx.state, b).available < 1) return json(ctx.res, 409, { error: 'No copies available' });
      const now = Date.now();
      const l = { id: nextId(ctx.state.loans), bookId: b.id, userId: ctx.user.id, borrowedAt: new Date(now).toISOString(), dueAt: new Date(now + 14 * DAY).toISOString(), returnedAt: null };
      ctx.state.loans.push(l);
      return json(ctx.res, 201, { ...l, title: b.title });
    }, { auth: true, role: 'member' }],
    ['POST', '/api/loans/:id/return', (ctx) => {
      const l = ctx.state.loans.find((x) => x.id === Number(ctx.params.id) && x.userId === ctx.user.id);
      if (!l || l.returnedAt) return json(ctx.res, 404, { error: 'Loan not found' });
      l.returnedAt = new Date().toISOString();
      return json(ctx.res, 200, { ok: true });
    }, { auth: true, role: 'member' }],
  ],
});

listen(server, 4103, BRAND);
