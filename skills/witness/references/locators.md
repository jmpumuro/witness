# Locators

`witness analyze` resolves every recorded target and checks candidate locators against the real page:
each candidate shows how many elements it matches and whether it is the element the developer used.
Use a candidate marked as verified (unique, same element); never guess.

## Order of preference

1. **Role + accessible name** — `getByRole('button', { name: 'Apply' })`
2. **Label** — `getByLabel('Email')` (form fields)
3. **Placeholder** — only when there is no label
4. **Test id** — `getByTestId('order-total')` (stable, but invisible to users)
5. **Scoped role** — `getByRole('row').filter({ hasText: name }).getByRole('button', { name: 'Edit' })`
6. **Role without a name** — weak (`getByRole('status')` is fine when the page has one; `getByRole('strong')` is not)
7. **Text** — for static copy only

`exact: true` in the analysis output is how uniqueness was checked; you may drop it in the test when the
name is distinctive.

## Repeated elements

Lists and tables repeat buttons ("Edit", "Delete", "Borrow"). Scope to the item, keyed by the most stable
text in it (a name, not a price):

```ts
const row = page.getByRole('row').filter({ hasText: productName });
await row.getByRole('button', { name: 'Edit' }).click();
```

Never use `nth()`, `first()`, `last()` or positional CSS (`nth-child`) to pick between repeated elements:
the order changes as data changes. Verify lint fails positional CSS and warns on `nth()`.

## When nothing is unique

If the analysis shows "no verified unique candidate":

- **The element is rendered by code in the feature's diff** → add an accessible name or a test id in the
  source (an icon-only button needs an `aria-label` anyway) and use it. Mention the change in the report.
- **Outside the diff** → scope to the nearest row, list item, dialog or form; list a test-id suggestion
  in the report. Use CSS only as a last resort, scoped, and say why.

## Frames, popups, dialogs

- iframes: `page.frameLocator(...)`; candidates are not computed inside frames, so keep codegen's locator
  and scope it.
- popups: keep codegen's `waitForEvent('popup')` pattern.
- native dialogs: register the handler before the click that triggers them:
  `page.once('dialog', (d) => d.accept())`.
