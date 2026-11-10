---
name: witness
description: Turn a developer's manual browser run into a verified, repeatable Playwright test. Use when someone wants integration/e2e tests from a recording, record-and-replay, "record this flow", "write a Playwright test for what I just did", or runs /witness:setup, /witness:record or /witness:re-record. Supports @playwright/test (TypeScript/JavaScript) and pytest-playwright (Python).
---

# Witness: recorded flows → verified Playwright tests

A developer exercises a feature by hand in a real browser. Witness records that run, replays it,
measures what every step did, and you recreate it as a clean Playwright test that is proven to do
the same thing and to check the outcomes that mattered.

**The recording is the source of truth.** The developer's manual run is the verification. You never
invent behaviour the recording does not show, never change an observed value to match what you
expected, and never weaken an assertion to make a test pass. Your judgment goes into *choosing*
(which observed changes are the checkpoints, which locator, how to make data repeatable), never
into *inventing*.

## Runtime

All mechanics live in a small CLI. Run it **from the root of the project under test**
(where `.witness/config.json` lives or will live). `<skill>` is this skill's directory.

| Project | Detect by | CLI |
|---|---|---|
| TypeScript / JS | `@playwright/test` in package.json | `node <skill>/runtime/node/witness.mjs <command>` |
| Python | `pytest-playwright` installed, `conftest.py` / `pytest.ini` | `PYTHONPATH=<skill>/runtime/python python -m witness_py <command>` |

Below, `witness <command>` means whichever applies. Every command prints a short Markdown summary;
details go to JSON under `.witness/`. Read [references/typescript.md](references/typescript.md) or
[references/python.md](references/python.md) before writing test code.

Files Witness uses in the project:

```
.witness/config.json               committed: base URL, roles, auth setup command, browser settings
.witness/flows/<flow>.json         committed: version history, spec path, locked checkpoints
.witness/recordings/<flow>/        gitignored: raw recording, HAR, analysis, evidence, reports
.witness/tmp/                      gitignored: disposable run directories
```

## Setup (`/witness:setup`)

Ask only what you cannot detect. Minimum: the app's base URL and one role to sign in as.

1. Detect the language and the Playwright config / pytest setup.
2. Find or create the login mechanism (Playwright's storage-state pattern):
   - TS: an `auth.setup.ts` in a `setup` project that saves `playwright/.auth/<role>.json`,
     with the other projects depending on it.
   - Python: a session fixture in `conftest.py` that logs in per role and a `tests/auth_setup.py`
     that saves `playwright/.auth/<role>.json`; tests pick a role with `@pytest.mark.role("<role>")`.
   - Credentials come **only** from environment variables. Ask for the variable *names*, never the
     values; never put a password in chat, code, or config.
   - If no login exists yet, offer to record one: `witness record login --role none --start /login`,
     then turn it into the setup file with env-var credentials.
3. Write the config:
   `witness setup --base-url <url> --role <role>=playwright/.auth/<role>.json --role-env <role>=<USER_ENV>,<PASS_ENV> --auth-setup "<command>"`
   (TS auth command: `npx playwright test --project=setup`; Python: `python -m pytest -q tests/auth_setup.py`).
4. `witness doctor`, fix anything it reports, and say in one line what was set up.

Data commands, user pools and the like are **not** part of setup. Add data handling only when a
recording proves it is needed (step 3 below).

## The flow (`/witness:record <flow>`)

Use a task list: record → analyze → prepare (if needed) → generate → verify → lock → report.

### 1. Record (human in the loop)

Run `witness record <flow> --role <role> --start <path>` **in the background** (it blocks until the
browser closes), then tell the developer what to do and **end your turn**:

> Opening a browser at `<url>`, signed in as `<role>`. Go through the feature by hand. Optional: use
> the toolbar's assert buttons on anything that proves it worked. Close the browser when you're done.
> I'll take it from there.

Do not continue until the process exits. If it reports that nothing was saved, say so and offer to
run the command again. Recording needs a visible browser on the developer's machine; if there is no
display (CI, remote container), explain that and offer `witness import` for a recording made elsewhere.

### 2. Analyze the raw recording

`witness analyze <flow>` replays the recording exactly as captured (twice, unless the first run
fails) and prints: each step's effect, a verified unique locator per step, checkpoint candidates,
divergences from the recording, overlays, dialogs, and a **Next** section. Follow **Next**.

How to read it:
- **observation** steps are clicks that changed nothing: the developer was *looking*. They are
  strong hints for checkpoints and are not reproduced as actions.
- **optional** steps (`focus-before-input`, `superseded-input` typo fixes, `overlay-dismiss`) need not
  be reproduced literally.
- **STATE-DEPENDENT**: the recording used up or created data (single-use coupon, unique email,
  booked slot), so the replay now takes a different path.
- **MISSING READ**: the UI listens to key events; `fill()` didn't trigger it → type with `pressSequentially`.
- **MISSING request + native dialog**: codegen records `dialog.dismiss()`; the developer clicked OK.

### 3. Prepare (only if the raw replay is not repeatable)

Write `prepared.spec.ts` / `prepared_test.py` next to the raw file: **the same steps in the same
order**, with only these changes allowed:

- make data fresh per run (unique values, or create/free what the flow consumes through the app's
  own API, e.g. `page.request` with the recording's session);
- accept a dialog the developer accepted; type with `pressSequentially` where a read went missing;
- narrow a recorded locator only when the extra matches come from data your preparation created.

Then `witness analyze <flow> --spec .witness/recordings/<flow>/prepared.spec.ts` until it reports
**Repeatable: yes**. Details and patterns: [references/data.md](references/data.md). If the flow
cannot be made repeatable (MFA, email links, third-party pages, no way to create data), stop and
explain what the app needs (a test hook, an API) instead of producing a fragile test.

### 4. Choose the checkpoints (no human gate)

Pick **2–5** from the analysis's checkpoint candidates. Never assert something that is not a
candidate. Rank them with everything you know: candidate score, `attended` (the developer looked at
it), the feature's code changes (`git diff` against the base branch: new strings, changed components,
new endpoints win), and your session context if you built the feature. Prefer user-visible outcomes;
use a network status only as support. Full rules and the assertion forms:
[references/checkpoints.md](references/checkpoints.md).

### 5. Generate the test

Recreate the flow as a clean test in the project's test directory:

- same actions in the same order as the (prepared) replay, minus optional steps;
- each locator from the analysis's verified candidate (role+name → label → placeholder → test id →
  scoped role → text). If none is unique and the element is rendered by code in the feature's diff,
  add a `data-testid` in the source and use it; otherwise scope to a row/list item and note it
  ([references/locators.md](references/locators.md));
- data handling from the prepared replay, moved into shared helpers (**reuse before creating**: read
  existing tests, fixtures and support files first and extend them rather than duplicating);
- overlays → `addLocatorHandler`; time-dependent text → `page.clock` or a regex; accepted dialogs →
  `page.once('dialog', d => d.accept())`;
- no sleeps, no `test.only`, no positional CSS, no credentials (env vars only);
- the header comment from the language reference (flow name, role, how to re-record).

### 6. Verify, and fix only the test

`witness verify <flow> --spec <test file>` runs: the test, **fidelity** to the replay (same actions,
pages and app calls), **vacuity** (each assertion must be false before the action it follows),
**repeat runs under 4× CPU throttling**, hygiene lint, a credential scan, and the assertion lock.

On failure, fix the **test** (or the preparation), never the baseline or the evidence. Do not
remove or loosen an assertion to get a pass; if a checkpoint cannot hold, choose a different
candidate and say why. After three unsuccessful fix attempts, stop and report what fails.
What each check means and typical fixes: [references/troubleshooting.md](references/troubleshooting.md).

### 7. Lock and report

`witness lock <flow>` records the assertions in `.witness/flows/<flow>.json`. From then on, verify
fails if an assertion changes; **only a re-record changes what a test asserts**.

Report briefly (this is what reviewers read; put it in the PR description when there is a PR):

```
Witness: <flow> → <test file>  (verified: fidelity 100%, 3/3 repeat runs, cpu ×4)
Checkpoints
 1. <what is asserted> — <why: e.g. new string in this diff; developer looked at it>
 2. …
Dropped: <notable candidates you did not use, and why>
Test data: <what the test creates or frees, or "none">
Suggestions: <data-testid additions outside the diff, app hooks needed>
```

If the evidence was thin (no diff, no observation clicks), say the checkpoints are lower confidence.

## Re-record (`/witness:re-record <flow>`)

Use when the feature changed, a reviewer says the test asserts the wrong thing, or verify fails
because a locked checkpoint changed. Read `.witness/flows/<flow>.json` for the role and start path,
then run `witness record <flow> --replace` (the previous recording is archived and the lock is
cleared) and repeat steps 2–7, updating the existing test file. In the report, list what changed in
the steps and, separately, in the checkpoints.

## Working unattended

Without a person present (CI, scheduled runs) you cannot record. You can still `import` a recording
made elsewhere (`witness import <flow> --from <dir> --role <r> --start <path>`) and run steps 2–7,
stating at the top of the report which choices you made.

## Out of scope

Say so plainly and suggest the fix on the app side: MFA or email-link login, flows through
third-party pages (OAuth providers, payment pages), canvas/WebGL interactions, server-side feature
flags that differ between environments, apps with no test environment.
