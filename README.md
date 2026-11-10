<p align="center"><img src="assets/icon.svg" width="96" alt="Witness icon: a record dot starting a replay loop around a check mark"></p>

# Witness

**Record a flow by hand in the browser. Get a verified, repeatable Playwright test.**

Witness is a Claude Code plugin (and an [Agent Skill](https://agentskills.io)) for developers who just
built a feature and need integration tests for it. You click through the feature once, as you would
anyway to check it works. Witness replays your recording, measures what every step did, and the agent
recreates it as a clean Playwright test, then **proves** the test does what you did:

- **Fidelity:** the test performs the same actions, visits the same pages and makes the same app calls as your recording.
- **Meaningful assertions:** every assertion is checked to be false *before* the action it follows, so nothing passes vacuously.
- **Stability:** the test is run repeatedly under 4× CPU throttling.
- **Hygiene:** no sleeps, no positional CSS, no credentials in code.
- **Locked checkpoints:** once verified, assertions can only change through a re-record.

Works with **@playwright/test** (TypeScript/JavaScript) and **pytest-playwright** (Python).

## Quick start

```text
/plugin marketplace add jmpumuro/witness
/plugin install witness@witness
```

Then, in your project:

```text
/witness:setup http://localhost:3000
/witness:record apply-coupon
```

A browser opens, signed in as your test user. Do the flow, close the browser, and Witness takes it from there.
You get a test file plus a short report: which checkpoints were chosen and why, what test data the test
creates, and the verification results.

| Command | What it does |
|---|---|
| `/witness:setup [base URL]` | One-time: base URL, test login roles (credentials from env vars only), auth setup |
| `/witness:record <flow>` | Record by hand → analyze → generate → verify → lock |
| `/witness:re-record <flow>` | The feature changed: record again and update the test and its locked checkpoints |

You can also just ask: *"record the checkout flow and turn it into a test"*.

## How it works

```
record (you)  →  raw replay ×2  →  prepare data (only if needed)  →  choose checkpoints  →  generate  →  verify  →  lock
   codegen +       per-step evidence:       e.g. a single-use coupon         from observed         clean test     fidelity, vacuity,
   HAR             effects, locators,        was used up by the recording     changes, ranked                      repeat ×N, lint,
                   network, divergences                                       with the code diff                   secrets, lock
```

1. **Record.** Playwright's codegen opens a browser with your test user's saved login and records your
   actions plus a network log.
2. **Analyze.** Witness replays the raw recording with instrumentation: an accessibility-tree snapshot
   before and after each step, the app calls it triggered, how long effects took to settle, and a set of
   candidate locators checked to be unique and to hit the same element. Comparing the replay with your
   network log reveals data the recording used up (a 409 that was a 200), event-driven widgets that
   `fill()` does not trigger, and confirm dialogs codegen dismissed but you accepted.
3. **Prepare** (only when needed). The same steps with fresh data per run, until replays are repeatable.
4. **Choose checkpoints.** Only from what actually changed on screen, ranked by what you looked at while
   recording (clicks with no effect), what is still on screen at the end, and the feature's code diff.
   No checkpoint dialog to fill in.
5. **Generate and verify.** The agent writes a test with the project's conventions and shared data helpers,
   then `witness verify` runs every check above. Failures are fixed in the test, never by weakening it.

The recording is the source of truth: the agent chooses, it never invents.

## What lands in your repository

```
tests/apply-coupon.spec.ts           a plain Playwright test (works without Witness)
tests/support/shop-data.ts           shared test-data helpers (reused across tests)
.witness/config.json                 base URL, roles, auth setup command
.witness/flows/apply-coupon.json     version history and locked checkpoints
.witness/recordings/                 gitignored: raw recordings may contain personal data
```

Stop using Witness tomorrow and you keep ordinary Playwright tests.

## Requirements

- A local, headed browser for recording (Claude Code running on your machine). Analysis and verification run headless anywhere, including CI.
- Node 18+ with `@playwright/test` ≥ 1.49, or Python 3.10+ with `pytest-playwright` (sync API).
- A test environment you can sign in to with a test account.

## Limits

Witness tells you plainly instead of producing a fragile test when a flow needs: MFA or email-link login,
third-party pages (OAuth providers, payment pages), canvas/WebGL interactions, server-side feature flags
that differ between environments, or data the app gives no way to create.

## Safety

- Credentials are read from environment variables only; verify scans generated tests and their helpers for credential values.
- Request bodies and responses saved during analysis are redacted for anything that looks like a password, token or key.
- Raw recordings stay out of git. Nothing is sent anywhere except to the app under test.

See [SECURITY.md](SECURITY.md).

## Evals and development

The repository includes three small demo apps (shop, clinic, library) with CRUD flows and edge cases,
and an eval suite that runs the whole pipeline in both languages, including **mutants**: deliberately
bad tests that verify must reject (vacuous assertion, fixed sleep, missing action, hardcoded password,
changed assertion).

```bash
npm install && npx playwright install chromium
pip install pytest-playwright && playwright install chromium
npm run eval -- --lang both      # 6 cases × 2 languages
npm run test:runtime             # conformance: Node and Python analysis must agree exactly
```

See [evals/README.md](evals/README.md) and [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Apache-2.0
