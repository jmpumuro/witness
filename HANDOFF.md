# Handoff: set up, test and try Witness in a dev environment

Instructions for the agent (or developer) taking this repository into a real development environment.
Work through the sections in order; each ends with a check.

## 0. What is already verified, and what is not

Verified in the build environment (Linux, Node 22, Python 3.13, Playwright 1.56 / 1.63, Chrome channel):

- `npm run test:runtime`: Node and Python analysis agree on 6 conformance vectors built from real evidence.
- `npm run eval -- --lang both`: all 6 cases pass in both languages (12 runs), including 12 mutants rejected for the right reason.
- `claude plugin validate .` passes.

**Not** verifiable there, and the most important things to test now:

1. A **real headed recording** with `/witness:record` (codegen opening a visible browser, the agent waiting in
   the background and resuming when the window closes). The evals simulate the recording instead.
2. **Installing from the marketplace** (`/plugin marketplace add`, `/plugin install`).
3. **Agent behaviour** end to end (the evals grade golden tests written by hand; section 5 grades the agent).
4. Playwright's **bundled browsers** (`npx playwright install`); the build machine used `PW_CHANNEL=chrome`.
5. Windows and macOS.

## 1. Install

```bash
unzip witness.zip && cd witness
npm install
npx playwright install chromium            # or: export PW_CHANNEL=chrome to use an installed Chrome
python -m pip install pytest-playwright
python -m playwright install chromium
```

Check: `npx playwright --version` and `python -c "import pytest_playwright"` both succeed.

## 2. Runtime and eval suites

```bash
npm run test:runtime                       # ~5 s
npm run eval -- --lang ts                  # ~10 min
npm run eval -- --lang py                  # ~10 min
```

Check: `6/6 cases passed` for each language. If a case fails, the output names the step (simulate, analyze,
analyze-prepared, verify, lock, mutant:<name>) and the reason; the full report is in `evals/results/`.
Common environment problems: a port in use (4101–4103: stop whatever holds it), browsers not installed,
or a stale demo app from an earlier run (`pkill -f examples/.*/server.js`).

## 3. Load the plugin in Claude Code

From the repository root:

```bash
claude plugin validate .
claude --plugin-dir .
```

In the session: `/help` should list `/witness:setup`, `/witness:record`, `/witness:re-record`.
Then try the marketplace path in a fresh session (after pushing the repo, replace OWNER):

```text
/plugin marketplace add jmpumuro/witness
/plugin install witness@witness
```

Before publishing, replace `OWNER` in `.claude-plugin/plugin.json`, `README.md` and `schema/evidence.schema.json`,
and confirm the plugin name `witness` is not already taken in the marketplaces your team uses (fallback: `pw-witness`).

## 4. A real recording (needs a display)

```bash
npm run apps                               # starts shop, clinic and library
cd examples/shop/e2e
cp .env.example .env && set -a && . ./.env && set +a
claude --plugin-dir ../../..
```

Then: `/witness:record apply-coupon --role customer --start /cart`

Do in the browser: accept the cookie banner, type `SAVE10` in "Coupon code", click Apply, look at the total
(click it once), close the browser.

Expected:
- The agent says it is waiting, ends its turn, and resumes by itself when the browser closes.
- Analysis reports STATE-DEPENDENT on `POST /api/cart/coupon` (the recording used the single-use coupon).
- The agent writes a prepared replay with a fresh coupon, reaches "Repeatable: yes", picks the toast and the
  `$45.00` total as checkpoints, writes `tests/apply-coupon.spec.ts`, verify passes, and it locks.
- Restart the shop app to reset data if you repeat this.

Repeat in Python (`examples/shop/e2e-py`) and with a flow of your own in a real project.

## 5. Grade the agent on all cases

Follow "Evaluating the agent" in `evals/README.md` for each case and language. Record for each run:
verify pass/fail, checkpoints chosen vs golden, whether shared helpers were reused, whether the agent ever
edited evidence or loosened an assertion (it must not), and time taken. These results are what a marketplace
submission and future prompt changes should be judged against.

## 6. Known limits and follow-ups

- Python runtime supports the **sync** API (pytest-playwright's default); async tests are not instrumented.
- The Node runtime mirrors test files into `.witness/tmp/` and rewrites `@playwright/test` imports there. Projects
  that import Playwright through a custom path alias need that alias resolvable from `.witness/tmp/`.
- Settling waits up to 5 s per step during analysis (quiet window 800 ms). Pages that never go quiet make
  analysis slow; `WITNESS_SETTLE_MAX_MS` and `WITNESS_SETTLE_QUIET_MS` tune it.
- Candidate locators are not computed inside iframes.
- Partial re-record (`--from <step>`) and `/witness:replay`, `/witness:list` were deliberately left out of v0.1.
