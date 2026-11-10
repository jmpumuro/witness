# Choosing checkpoints

A checkpoint is an outcome the developer verified by hand. You pick 2–5 of them from the analysis's
**checkpoint candidates**; you never assert anything that is not a candidate.

## Where candidates come from

`witness analyze` diffs the page's accessibility tree before and after every action and lists what
appeared, disappeared, navigated, or which app calls succeeded. Each candidate is non-vacuous by
construction (it was not there before the action) and carries signals:

| Signal | Meaning |
|---|---|
| `attended` | The developer clicked it without effect afterwards: they were looking at it. Strongest signal. |
| `final` | Still on screen when the recording ended. |
| `stable` / `dynamic` / `unstable` | Same in every replay / same except numbers / different. Never use `unstable`. |
| `time-like` | Contains a date, time or duration. Pin the clock or use a regex. |
| `score` | A starting rank from these signals. Your judgment can override it. |

## How to rank with context

1. **The feature's diff.** `git diff <base>...HEAD` (or the working tree). A candidate rendered by changed
   code (new copy string, changed component, new endpoint) is about the feature; page chrome is not.
2. **Your session.** If you built the feature in this session, you know what the change is for: prefer the
   outcome over its side effects ("total shows the discount" over "cart badge re-rendered").
3. **User-visible outcome first.** Messages, values, rows, navigation. A network status is supporting
   evidence only; include it when the UI change is subtle.
4. **One checkpoint per distinct outcome.** A toast and a changed total are two outcomes; a toast and its
   duplicate live region are one.

If your expectation and the observation disagree (you built a 10% discount, the page showed $44.50),
**do not change the value**. Assert what was observed only if it is correct; otherwise stop and report
the likely bug to the developer. The recording wins on facts.

## Assertion forms

| Outcome | Form |
|---|---|
| Computed value (total, count) is the feature | exact: `toHaveText('$45.00')` |
| Message | `getByRole('status' / 'alert')` + `toHaveText(...)` |
| Text with a dynamic part | regex: `toHaveText(/^Order #\d+ confirmed$/)` (the analysis suggests one) |
| New row / list item | scope + `toContainText(...)` |
| Removed row | `toHaveCount(0)` on the scoped locator |
| Navigation | `toHaveURL(/\/patients\/\d+/)` |
| Structure of one region matters | `toMatchAriaSnapshot` on that region only, never the whole page |
| Date-dependent text | pin `page.clock` (setFixedTime) before navigating, then assert exact text |

Avoid asserting:
- anything already true before the action (verify's vacuity check will fail it). Example: a row that
  exists on the "All" tab still exists after clicking "On loan"; assert that a row which should
  *disappear* is gone instead;
- marketing copy or layout text that is not what the feature changed;
- more than five things. More assertions are not more verification.

## Reasons (for the report)

Give each checkpoint a one-line reason a reviewer can check in seconds:

- "New string in this diff; developer looked at it after Apply."
- "Computed by the changed applyDiscount(); still on screen at the end."
- "New endpoint POST /api/coupons/apply returned 200; supports #1."

And list notable candidates you dropped: "cart badge re-render (side effect)", "timestamp in header (unstable)".
