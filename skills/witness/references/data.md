# Making flows repeatable

A recording changes the app: it uses a coupon, creates a patient, books a slot. Replaying it then takes
a different path. `witness analyze` detects this by comparing the replay's app calls with the recording's
network log (and replays with each other): **STATE-DEPENDENT** means a call that succeeded while recording
now fails.

Only make changes when the analysis shows a divergence. Read-only and net-neutral flows (borrow then
return) need nothing.

## The prepared replay

`prepared.spec.ts` / `prepared_test.py` sits next to the raw file and keeps **the same steps in the same
order**. Allowed changes:

| Situation | Change |
|---|---|
| A value must be unique (email, product name) | add a per-run suffix |
| The flow consumes something (single-use coupon, slot, stock) | create a fresh one, or free the used one, through the app's API before the steps |
| The flow needs a starting state (cart with one item) | set it through the API before the steps |
| The developer accepted a confirm dialog | accept it (codegen records dismiss) |
| A read went missing (key-driven widget) | type with `pressSequentially` |
| A recorded locator now matches extra elements your preparation created | narrow it (e.g. to the "Booked" row) |

Not allowed: changing, removing or reordering actions; changing what was observed.

Use the **App API calls observed** section of the analysis to find the endpoints: they include request
bodies (with secrets redacted).

## Patterns

**Use the recording's session** (`page.request` shares cookies with the page and is not counted as an app
call by verify):

```ts
await page.request.put('/api/cart', { data: { items: [{ productId: 1, qty: 1 }] } });
```

**Another role** (e.g. an admin creates what the customer uses), with credentials from the environment:

```ts
const admin = await request.newContext({ baseURL });
await admin.post('/api/login', { data: { email: process.env.SHOP_ADMIN_EMAIL, password: process.env.SHOP_ADMIN_PASSWORD } });
await admin.post('/api/coupons', { data: { code, percent: 10 } });
await admin.dispose();
```

**Free instead of create** when the resource is fixed (a time slot): cancel whatever holds it.

**Unique values**: `${base} ${Date.now().toString(36)}${random}`; keep the human-readable part so failures
are easy to read.

**Clock**: text computed from the current date ("Overdue by 9 days") → `page.clock.setFixedTime(...)`
before the first navigation. The server's clock is not affected; pin dates that come from the server with
test data instead.

## In the final test

Move preparation into shared helpers (e.g. `tests/support/<app>-data.ts`, `tests/support/<app>_data.py`).
Read what exists first and extend it: one coupon helper for the whole suite, not one per test.

## When the app gives you no way

No API to create the data, no way to free it, login needs MFA or an email link: do not paper over it with
retries or by deleting checks. Tell the developer what the app needs (a seed endpoint, a test-only reset
in non-production builds, a test user without MFA) and stop.
