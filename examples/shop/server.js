'use strict';
// Shop demo app (e-commerce). Edge cases exercised by Witness evals:
//  - single-use coupons (consumable data: replaying an "apply coupon" recording fails with 409)
//  - delayed confirmation toast (async effect ~600ms after the response)
//  - cookie-consent overlay that appears after a short delay and blocks clicks
//  - debounced product search
//  - repeated "Add to cart" / "Edit" / "Delete" buttons (ambiguous locators unless scoped)
//  - confirm() dialog on delete, duplicate-name 409 on create, validation 400s
//  - dynamic order numbers and timestamps
const { createServer, layout, json, html, redirect, escapeHtml, nextId, listen, authRoutes } = require('../_shared/mini');

const BRAND = 'Northwind Shop';

function seed() {
  return {
    users: [
      { id: 1, email: 'alice@shop.test', password: process.env.SHOP_CUSTOMER_PASSWORD || 'alice-pass', name: 'Alice Moreno', role: 'customer', home: '/' },
      { id: 2, email: 'admin@shop.test', password: process.env.SHOP_ADMIN_PASSWORD || 'admin-pass', name: 'Sam Admin', role: 'admin', home: '/admin/products' },
    ],
    products: [
      { id: 1, name: 'Desk Lamp', priceCents: 5000, stock: 10 },
      { id: 2, name: 'Notebook', priceCents: 800, stock: 100 },
      { id: 3, name: 'Monitor Arm', priceCents: 12000, stock: 0 },
      { id: 4, name: 'Desk Mat', priceCents: 2500, stock: 25 },
      { id: 5, name: 'Cable Tray', priceCents: 1800, stock: 12 },
    ],
    coupons: [
      { code: 'SAVE10', percent: 10, singleUse: true, expiresAt: '2099-01-01T00:00:00Z' },
      { code: 'WELCOME5', percent: 5, singleUse: false, expiresAt: '2099-01-01T00:00:00Z' },
      { code: 'SUMMER24', percent: 20, singleUse: false, expiresAt: '2024-09-01T00:00:00Z' },
    ],
    usedCoupons: [], // { userId, code }
    carts: { 1: { items: [{ productId: 1, qty: 1 }], coupon: null } },
    orders: [],
    orderSeq: 1041,
  };
}

const cartOf = (state, userId) => (state.carts[userId] ||= { items: [], coupon: null });

function cartView(state, userId) {
  const cart = cartOf(state, userId);
  const lines = cart.items.map((i) => {
    const p = state.products.find((x) => x.id === i.productId);
    return p ? { productId: p.id, name: p.name, qty: i.qty, priceCents: p.priceCents, lineCents: p.priceCents * i.qty } : null;
  }).filter(Boolean);
  const subtotalCents = lines.reduce((s, l) => s + l.lineCents, 0);
  const coupon = cart.coupon ? state.coupons.find((c) => c.code === cart.coupon) : null;
  const discountCents = coupon ? Math.round(subtotalCents * coupon.percent / 100) : 0;
  return { lines, subtotalCents, coupon: coupon ? { code: coupon.code, percent: coupon.percent } : null, discountCents, totalCents: subtotalCents - discountCents };
}

const COOKIE_BANNER = `
(function () {
  if (document.cookie.includes('consent=1')) return;
  setTimeout(() => {
    const wrap = document.createElement('div');
    wrap.id = 'cookie-consent';
    wrap.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.35);display:flex;align-items:flex-end;justify-content:center;z-index:50';
    wrap.innerHTML = '<div role="dialog" aria-label="Cookie consent" style="background:#fff;padding:16px 20px;margin:20px;border-radius:10px;max-width:520px">'
      + '<p>We use cookies to keep you signed in and to remember your cart.</p>'
      + '<button class="primary" id="cookie-accept">Accept</button> <button id="cookie-reject">Reject non-essential</button></div>';
    document.body.appendChild(wrap);
    const close = () => { document.cookie = 'consent=1; path=/'; wrap.remove(); };
    document.getElementById('cookie-accept').onclick = close;
    document.getElementById('cookie-reject').onclick = close;
  }, 300);
})();`;

function page(ctx, title, body, script) {
  const nav = ctx.user && ctx.user.role === 'admin'
    ? [{ href: '/admin/products', label: 'Products admin' }, { href: '/', label: 'Storefront' }]
    : [{ href: '/', label: 'Products' }, { href: '/cart', label: 'Cart' }];
  return html(ctx.res, 200, layout({ title, brand: BRAND, nav, user: ctx.user, body, script: COOKIE_BANNER + (script || '') }));
}

// ---------- pages ----------

function storefront(ctx) {
  return page(ctx, 'Products', `
<h1>Products</h1>
<label for="search">Search products</label>
<input id="search" type="search" placeholder="Search by name" style="width:100%;max-width:360px">
<p id="result-count" class="muted" aria-live="polite"></p>
<ul class="plain" id="products" aria-label="Products"></ul>`, `
let timer;
async function load(q) {
  const r = await api('GET', '/api/products?q=' + encodeURIComponent(q || ''));
  const list = document.getElementById('products');
  list.innerHTML = r.data.products.map(p => '<li><div class="grow"><strong>' + esc(p.name) + '</strong><div class="muted">' + money(p.priceCents) + ' · ' + (p.stock > 0 ? p.stock + ' in stock' : 'Out of stock') + '</div></div>'
    + (p.stock > 0 ? '<button data-id="' + p.id + '">Add to cart</button>' : '<button disabled>Out of stock</button>') + '</li>').join('');
  document.getElementById('result-count').textContent = r.data.products.length + ' products';
}
document.getElementById('search').addEventListener('input', (e) => { clearTimeout(timer); timer = setTimeout(() => load(e.target.value), 300); });
document.getElementById('products').addEventListener('click', async (e) => {
  const id = e.target.dataset && e.target.dataset.id; if (!id) return;
  const r = await api('POST', '/api/cart/items', { productId: Number(id), qty: 1 });
  toast(r.ok ? 'Added to cart' : (r.data.error || 'Could not add'), 0);
});
load('');`);
}

function cartPage(ctx) {
  return page(ctx, 'Cart', `
<h1>Your cart</h1>
<table aria-label="Cart items"><thead><tr><th>Item</th><th>Quantity</th><th>Price</th><th></th></tr></thead><tbody id="lines"></tbody></table>
<p id="qty-error" role="alert" class="field-error"></p>
<div class="card" style="margin-top:16px">
  <label for="coupon">Coupon code</label>
  <input id="coupon" autocomplete="off"> <button id="apply">Apply</button>
  <p id="coupon-error" role="alert" class="field-error"></p>
</div>
<div class="card">
  <p>Subtotal: <span id="subtotal"></span></p>
  <p id="discount-row" hidden>Discount (<span id="discount-label"></span>): -<span id="discount"></span></p>
  <p>Total: <strong data-testid="order-total" id="total"></strong></p>
  <button class="primary" id="checkout">Place order</button>
</div>`, `
async function render() {
  const r = await api('GET', '/api/cart');
  const c = r.data;
  document.getElementById('lines').innerHTML = c.lines.length ? c.lines.map(l => '<tr><td>' + esc(l.name) + '</td><td><input type="number" min="1" max="5" value="' + l.qty + '" aria-label="Quantity for ' + esc(l.name) + '" data-id="' + l.productId + '" style="width:70px"></td><td>' + money(l.lineCents) + '</td><td><button data-remove="' + l.productId + '">Remove</button></td></tr>').join('')
    : '<tr><td colspan="4" class="muted">Your cart is empty</td></tr>';
  document.getElementById('subtotal').textContent = money(c.subtotalCents);
  document.getElementById('discount-row').hidden = !c.coupon;
  if (c.coupon) { document.getElementById('discount-label').textContent = c.coupon.code + ' ' + c.coupon.percent + '%'; document.getElementById('discount').textContent = money(c.discountCents); }
  document.getElementById('total').textContent = money(c.totalCents);
  document.getElementById('checkout').disabled = !c.lines.length;
}
document.getElementById('apply').addEventListener('click', async () => {
  const err = document.getElementById('coupon-error'); err.textContent = '';
  const r = await api('POST', '/api/cart/coupon', { code: document.getElementById('coupon').value });
  if (!r.ok) { err.textContent = r.data.error; return; }
  await render();
  toast('Coupon applied', 600);
});
document.getElementById('lines').addEventListener('change', async (e) => {
  const id = e.target.dataset.id; if (!id) return;
  const r = await api('PUT', '/api/cart/items/' + id, { qty: Number(e.target.value) });
  document.getElementById('qty-error').textContent = r.ok ? '' : r.data.error;
  await render();
});
document.getElementById('lines').addEventListener('click', async (e) => {
  const id = e.target.dataset.remove; if (!id) return;
  await api('DELETE', '/api/cart/items/' + id); await render(); toast('Item removed', 0);
});
document.getElementById('checkout').addEventListener('click', async () => {
  const r = await api('POST', '/api/orders');
  if (r.ok) location.href = '/orders/' + r.data.id;
});
render();`);
}

function orderPage(ctx) {
  const o = ctx.state.orders.find((x) => x.id === Number(ctx.params.id) && x.userId === ctx.user.id);
  if (!o) return html(ctx.res, 404, '<h1>Order not found</h1>');
  const placed = new Date(o.placedAt).toLocaleTimeString('en-US', { hour12: false });
  return page(ctx, 'Order confirmed', `
<div class="card"><h1>Order #${o.number} confirmed</h1>
<p class="muted">Placed at ${escapeHtml(placed)}</p>
<p>Total paid: <strong data-testid="order-total">$${(o.totalCents / 100).toFixed(2)}</strong></p>
<p>${o.items.length} item(s) will ship within 2 business days.</p></div>`);
}

function adminProducts(ctx) {
  return page(ctx, 'Products admin', `
<h1>Products admin</h1>
<div class="card">
  <h2 id="form-title">New product</h2>
  <form id="product-form" novalidate>
    <input type="hidden" id="product-id">
    <label for="name">Product name</label><input id="name" style="width:100%">
    <label for="price">Price (USD)</label><input id="price" inputmode="decimal">
    <label for="stock">Stock</label><input id="stock" type="number" min="0">
    <p id="form-error" role="alert" class="field-error"></p>
    <button class="primary" type="submit" id="save">Create product</button>
    <button type="button" id="cancel-edit" hidden>Cancel</button>
  </form>
</div>
<table aria-label="Products"><thead><tr><th>Name</th><th>Price</th><th>Stock</th><th>Actions</th></tr></thead><tbody id="rows"></tbody></table>`, `
let products = [];
async function load() {
  const r = await api('GET', '/api/products');
  products = r.data.products;
  document.getElementById('rows').innerHTML = products.map(p => '<tr><td>' + esc(p.name) + '</td><td>' + money(p.priceCents) + '</td><td>' + p.stock + '</td><td><button data-edit="' + p.id + '">Edit</button> <button data-delete="' + p.id + '">Delete</button></td></tr>').join('');
}
function resetForm() {
  ['product-id','name','price','stock'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('form-title').textContent = 'New product';
  document.getElementById('save').textContent = 'Create product';
  document.getElementById('cancel-edit').hidden = true;
  document.getElementById('form-error').textContent = '';
}
document.getElementById('cancel-edit').onclick = resetForm;
document.getElementById('rows').addEventListener('click', async (e) => {
  if (e.target.dataset.edit) {
    const p = products.find(x => x.id === Number(e.target.dataset.edit));
    document.getElementById('product-id').value = p.id;
    document.getElementById('name').value = p.name;
    document.getElementById('price').value = (p.priceCents / 100).toFixed(2);
    document.getElementById('stock').value = p.stock;
    document.getElementById('form-title').textContent = 'Edit ' + p.name;
    document.getElementById('save').textContent = 'Save changes';
    document.getElementById('cancel-edit').hidden = false;
  }
  if (e.target.dataset.delete) {
    const p = products.find(x => x.id === Number(e.target.dataset.delete));
    if (!confirm('Delete ' + p.name + '?')) return;
    const r = await api('DELETE', '/api/products/' + p.id);
    if (r.ok) { toast('Product deleted', 0); load(); } else toast(r.data.error, 0);
  }
});
document.getElementById('product-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = document.getElementById('product-id').value;
  const body = { name: document.getElementById('name').value, price: document.getElementById('price').value, stock: document.getElementById('stock').value };
  const r = id ? await api('PUT', '/api/products/' + id, body) : await api('POST', '/api/products', body);
  if (!r.ok) { document.getElementById('form-error').textContent = r.data.error; return; }
  toast(id ? 'Product updated' : 'Product created', 0);
  resetForm(); load();
});
load();`);
}

// ---------- validation ----------

function validateProduct(state, body, existingId) {
  const name = String(body.name || '').trim();
  if (!name) return { status: 400, error: 'Product name is required' };
  const price = Number(String(body.price ?? '').replace(/[$,]/g, ''));
  if (!Number.isFinite(price) || price <= 0) return { status: 400, error: 'Price must be greater than 0' };
  const stock = Number(body.stock ?? 0);
  if (!Number.isInteger(stock) || stock < 0) return { status: 400, error: 'Stock must be a whole number of 0 or more' };
  if (state.products.some((p) => p.name.toLowerCase() === name.toLowerCase() && p.id !== existingId)) {
    return { status: 409, error: 'A product with this name already exists' };
  }
  return { value: { name, priceCents: Math.round(price * 100), stock } };
}

// ---------- routes ----------

const server = createServer({
  name: BRAND,
  seed,
  routes: [
    ...authRoutes({ brand: BRAND, home: '/' }),
    ['GET', '/', storefront, { auth: true }],
    ['GET', '/cart', cartPage, { auth: true }],
    ['GET', '/orders/:id', orderPage, { auth: true }],
    ['GET', '/admin/products', adminProducts, { auth: true, role: 'admin' }],

    ['GET', '/api/products', (ctx) => {
      const q = String(ctx.query.q || '').toLowerCase();
      return json(ctx.res, 200, { products: ctx.state.products.filter((p) => p.name.toLowerCase().includes(q)) });
    }, { auth: true }],
    ['POST', '/api/products', (ctx) => {
      const v = validateProduct(ctx.state, ctx.body);
      if (v.error) return json(ctx.res, v.status, { error: v.error });
      const p = { id: nextId(ctx.state.products), ...v.value };
      ctx.state.products.push(p);
      return json(ctx.res, 201, p);
    }, { auth: true, role: 'admin' }],
    ['PUT', '/api/products/:id', (ctx) => {
      const p = ctx.state.products.find((x) => x.id === Number(ctx.params.id));
      if (!p) return json(ctx.res, 404, { error: 'Product not found' });
      const v = validateProduct(ctx.state, ctx.body, p.id);
      if (v.error) return json(ctx.res, v.status, { error: v.error });
      Object.assign(p, v.value);
      return json(ctx.res, 200, p);
    }, { auth: true, role: 'admin' }],
    ['DELETE', '/api/products/:id', (ctx) => {
      const i = ctx.state.products.findIndex((x) => x.id === Number(ctx.params.id));
      if (i < 0) return json(ctx.res, 404, { error: 'Product not found' });
      ctx.state.products.splice(i, 1);
      for (const c of Object.values(ctx.state.carts)) c.items = c.items.filter((it) => it.productId !== Number(ctx.params.id));
      return json(ctx.res, 200, { ok: true });
    }, { auth: true, role: 'admin' }],

    ['POST', '/api/coupons', (ctx) => {
      const code = String(ctx.body.code || '').trim().toUpperCase();
      const percent = Number(ctx.body.percent);
      if (!/^[A-Z0-9-]{3,32}$/.test(code)) return json(ctx.res, 400, { error: 'Code must be 3-32 letters, digits or dashes' });
      if (!(percent > 0 && percent <= 90)) return json(ctx.res, 400, { error: 'Percent must be between 1 and 90' });
      if (ctx.state.coupons.some((c) => c.code === code)) return json(ctx.res, 409, { error: 'Coupon code already exists' });
      const c = { code, percent, singleUse: ctx.body.singleUse !== false, expiresAt: ctx.body.expiresAt || '2099-01-01T00:00:00Z' };
      ctx.state.coupons.push(c);
      return json(ctx.res, 201, c);
    }, { auth: true, role: 'admin' }],

    ['GET', '/api/cart', (ctx) => json(ctx.res, 200, cartView(ctx.state, ctx.user.id)), { auth: true }],
    ['PUT', '/api/cart', (ctx) => {
      // Replace cart contents (used by tests to provision a known cart).
      const items = Array.isArray(ctx.body.items) ? ctx.body.items : [];
      for (const it of items) {
        const p = ctx.state.products.find((x) => x.id === Number(it.productId));
        if (!p) return json(ctx.res, 400, { error: 'Unknown product ' + it.productId });
        if (!(it.qty >= 1 && it.qty <= 5)) return json(ctx.res, 400, { error: 'Max 5 per item' });
      }
      ctx.state.carts[ctx.user.id] = { items: items.map((i) => ({ productId: Number(i.productId), qty: Number(i.qty) })), coupon: null };
      return json(ctx.res, 200, cartView(ctx.state, ctx.user.id));
    }, { auth: true }],
    ['POST', '/api/cart/items', (ctx) => {
      const p = ctx.state.products.find((x) => x.id === Number(ctx.body.productId));
      if (!p) return json(ctx.res, 404, { error: 'Product not found' });
      if (p.stock < 1) return json(ctx.res, 409, { error: 'Out of stock' });
      const cart = cartOf(ctx.state, ctx.user.id);
      const line = cart.items.find((i) => i.productId === p.id);
      if (line && line.qty >= 5) return json(ctx.res, 422, { error: 'Max 5 per item' });
      if (line) line.qty += 1; else cart.items.push({ productId: p.id, qty: 1 });
      return json(ctx.res, 201, cartView(ctx.state, ctx.user.id));
    }, { auth: true }],
    ['PUT', '/api/cart/items/:productId', (ctx) => {
      const cart = cartOf(ctx.state, ctx.user.id);
      const line = cart.items.find((i) => i.productId === Number(ctx.params.productId));
      if (!line) return json(ctx.res, 404, { error: 'Item not in cart' });
      const qty = Number(ctx.body.qty);
      if (!(Number.isInteger(qty) && qty >= 1 && qty <= 5)) return json(ctx.res, 422, { error: 'Max 5 per item' });
      line.qty = qty;
      return json(ctx.res, 200, cartView(ctx.state, ctx.user.id));
    }, { auth: true }],
    ['DELETE', '/api/cart/items/:productId', (ctx) => {
      const cart = cartOf(ctx.state, ctx.user.id);
      cart.items = cart.items.filter((i) => i.productId !== Number(ctx.params.productId));
      return json(ctx.res, 200, cartView(ctx.state, ctx.user.id));
    }, { auth: true }],
    ['POST', '/api/cart/coupon', (ctx) => {
      const code = String(ctx.body.code || '').trim().toUpperCase();
      const c = ctx.state.coupons.find((x) => x.code === code);
      if (!c) return json(ctx.res, 404, { error: 'Invalid code' });
      if (new Date(c.expiresAt) < new Date()) return json(ctx.res, 410, { error: 'This coupon has expired' });
      if (c.singleUse && ctx.state.usedCoupons.some((u) => u.userId === ctx.user.id && u.code === code)) {
        return json(ctx.res, 409, { error: 'You have already used this coupon' });
      }
      if (c.singleUse) ctx.state.usedCoupons.push({ userId: ctx.user.id, code });
      cartOf(ctx.state, ctx.user.id).coupon = code;
      return json(ctx.res, 200, cartView(ctx.state, ctx.user.id));
    }, { auth: true }],

    ['POST', '/api/orders', (ctx) => {
      const view = cartView(ctx.state, ctx.user.id);
      if (!view.lines.length) return json(ctx.res, 422, { error: 'Your cart is empty' });
      const o = { id: nextId(ctx.state.orders), number: ++ctx.state.orderSeq, userId: ctx.user.id, items: view.lines, totalCents: view.totalCents, placedAt: new Date().toISOString() };
      ctx.state.orders.push(o);
      ctx.state.carts[ctx.user.id] = { items: [], coupon: null };
      return json(ctx.res, 201, { id: o.id, number: o.number });
    }, { auth: true }],
  ],
});

listen(server, 4101, BRAND);
