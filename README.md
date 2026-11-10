# Witness

<p align="center"><img src="assets/icon.svg" width="96" alt="Witness icon: a record dot starting a replay loop around a check mark"></p>

[![CI](https://github.com/jmpumuro/witness/actions/workflows/ci.yml/badge.svg)](https://github.com/jmpumuro/witness/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Claude Code plugin](https://img.shields.io/badge/Claude%20Code-plugin-d97757.svg)](https://code.claude.com/docs/en/plugins/install.md)

Record a flow by hand in the browser; get a verified, repeatable Playwright test (Claude Code plugin)

Witness is a [Claude Code](https://code.claude.com) plugin (and an [Agent Skill](https://agentskills.io)) for
developers who just built a feature and need integration tests for it. You click through the feature once, as
you would anyway to check it works. Witness replays your recording, measures what every step did, and Claude
recreates it as a clean Playwright test, then **proves** the test does what you did:

- **Fidelity:** the test performs the same actions, visits the same pages and makes the same app calls as your recording.
- **Meaningful assertions:** every assertion is checked to be false *before* the action it follows, so nothing passes vacuously.
- **Stability:** the test is run repeatedly under 4× CPU throttling.
- **Hygiene:** no sleeps, no positional CSS, no credentials in code.
- **Locked checkpoints:** once verified, assertions can only change through a re-record.

Works with **@playwright/test** (TypeScript/JavaScript) and **pytest-playwright** (Python).

## Table of Contents

- [Background](#background)
- [Install](#install)
- [Usage](#usage)
- [What lands in your repository](#what-lands-in-your-repository)
- [Limits](#limits)
- [Security](#security)
- [Development](#development)
- [Maintainers](#maintainers)
- [Contributing](#contributing)
- [License](#license)

## Background

Recorded tests usually fail for boring reasons: the recording used up data (a single-use coupon, a unique
email), a widget listens for key events that `fill()` never sends, codegen dismissed a confirm dialog you
accepted, or an assertion was already true before the action. Witness finds these by measuring a replay of
your recording instead of trusting the generated code.

```
record (you)  →  raw replay ×2  →  prepare data (only if needed)  →  choose checkpoints  →  generate  →  verify  →  lock
   codegen +       per-step evidence:       e.g. a single-use coupon         from observed         clean test     fidelity, vacuity,
   HAR             effects, locators,        was used up by the recording     changes, ranked                      repeat ×N, lint,
                   network, divergences                                       with the code diff                   secrets, lock
```

1. **Record.** Playwright's codegen opens a browser with your test user's saved login and records your
   actions plus a network log.
2. **Analyze.** Witness replays the raw recording against the live app with instrumentation: an
   accessibility-tree snapshot before and after each step, the app calls it triggered, how long effects took
   to settle, and candidate locators checked to be unique and to hit the same element. Comparing the replay
   with your network log reveals data the recording used up (a 409 that was a 200), event-driven widgets, and
   dialogs codegen dismissed but you accepted.
3. **Prepare** (only when needed). The same steps with fresh data per run, until replays are repeatable.
4. **Choose checkpoints.** Only from what actually changed on screen, ranked by what you looked at while
   recording (clicks with no effect), what is still on screen at the end, and the feature's code diff.
5. **Generate and verify.** Claude writes a test with the project's conventions and shared data helpers,
   then `witness verify` runs every check above. Failures are fixed in the test, never by weakening it.

The recording is the source of truth: Claude chooses, it never invents.

## Install

Add this repository as a plugin marketplace, then install the plugin from it. In a Claude Code session:

```text
/plugin marketplace add jmpumuro/witness
/plugin install witness@witness
```

Or from your shell, for example in a setup script:

```bash
claude plugin marketplace add jmpumuro/witness
claude plugin install witness@witness
```

Check that it loaded: `claude plugin list` shows `witness@witness` with `Status: ✔ enabled`, and typing `/` in a
session lists `/witness:setup`, `/witness:record` and `/witness:re-record`. A plugin installed from the shell
loads in the next session, or after `/reload-plugins`.

**For a team.** Install at project scope so the plugin is enabled for everyone working in the repository
(this writes `.claude/settings.json`, which you commit). Each collaborator runs the same command once per clone:

```bash
claude plugin install witness@witness --scope project
```

**Update or remove.** Third-party marketplaces don't auto-update by default:

```bash
claude plugin marketplace update witness   # refresh the listing
claude plugin update witness@witness       # install the new version, then /reload-plugins
claude plugin uninstall witness@witness
```

### Dependencies

- Claude Code running on your machine, with a display: recording opens a visible browser. Analysis and
  verification run headless anywhere, including CI.
- **TypeScript/JavaScript projects:** Node 18+ and `@playwright/test` ≥ 1.49 with a browser installed
  (`npx playwright install chromium`).
- **Python projects:** Python 3.10+ and `pytest-playwright` (sync API) with a browser installed
  (`python -m playwright install chromium`).
- A test environment you can sign in to with a test account.

Tested on Linux (CI) and macOS.

## Usage

In your project:

```text
/witness:setup http://localhost:3000
/witness:record apply-coupon
```

A browser opens, signed in as your test user. Do the flow, close the browser, and Witness takes it from there.
You get a test file plus a short report: which checkpoints were chosen and why, what test data the test
creates, and the verification results.

```
Witness: apply-coupon → tests/apply-coupon.spec.ts  (verified: fidelity 100%, 3/3 repeat runs, cpu ×4)
Checkpoints
 1. Toast "Coupon applied" — new string in this diff; you looked at it after Apply
 2. Total "$45.00" — computed by the changed applyDiscount(); still on screen at the end
Test data: creates a fresh single-use coupon per run
```

| Command | What it does |
|---|---|
| `/witness:setup [base URL]` | One-time: base URL, test login roles (credentials from env vars only), auth setup |
| `/witness:record <flow> [--role <role>] [--start </path>]` | Record by hand → analyze → generate → verify → lock |
| `/witness:re-record <flow>` | The feature changed: record again and update the test and its locked checkpoints |

You can also just ask: *"record the checkout flow and turn it into a test"*.

### CLI

The commands above drive a small CLI bundled with the plugin, which you can also run yourself from the project
root (for example in CI, where nobody can record):

```bash
node <plugin>/skills/witness/runtime/node/witness.mjs <command>                      # TypeScript/JavaScript
PYTHONPATH=<plugin>/skills/witness/runtime/python python -m witness_py <command>     # Python
```

Commands: `setup`, `doctor`, `record`, `import`, `analyze`, `verify`, `lock`, `status`. `witness import` brings
in a recording made elsewhere; `witness verify <flow> --spec <file>` re-checks a test against its locked
checkpoints.

## What lands in your repository

```
tests/apply-coupon.spec.ts           a plain Playwright test (works without Witness)
tests/support/shop-data.ts           shared test-data helpers (reused across tests)
.witness/config.json                 base URL, roles, auth setup command
.witness/flows/apply-coupon.json     version history and locked checkpoints
.witness/recordings/                 gitignored: raw recordings may contain personal data
```

Stop using Witness tomorrow and you keep ordinary Playwright tests.

## Limits

Witness tells you plainly instead of producing a fragile test when a flow needs: MFA or email-link login,
third-party pages (OAuth providers, payment pages), canvas/WebGL interactions, server-side feature flags
that differ between environments, or data the app gives no way to create.

Not supported in this version:

- Browser extensions: Playwright's codegen cannot load an unpacked extension, so extension pages and
  content scripts cannot be recorded.
- Async Python tests (pytest-playwright's sync API is supported).
- Locators inside iframes.

## Security

- Credentials are read from environment variables only; verify scans generated tests and their helpers for credential values.
- Request bodies and responses saved during analysis are redacted for anything that looks like a password, token or key.
- Raw recordings stay out of git. Nothing is sent anywhere except to the app under test.

See [SECURITY.md](SECURITY.md) for details and how to report a vulnerability.

## Development

The repository includes three small demo apps (shop, clinic, library) with CRUD flows and edge cases,
and an eval suite that runs the whole pipeline in both languages, including **mutants**: deliberately
bad tests that verify must reject (vacuous assertion, fixed sleep, missing action, hardcoded password,
changed assertion).

```bash
npm install && npx playwright install chromium
pip install pytest-playwright && python -m playwright install chromium
npm run test:runtime             # conformance: Node and Python analysis must agree exactly
npm run eval -- --lang both      # 6 cases × 2 languages (≈20 min)
```

To try local changes to the plugin without installing it, start Claude Code with `claude --plugin-dir .`, and
run `claude plugin validate .` before you push. See [evals/README.md](evals/README.md) and
[HANDOFF.md](HANDOFF.md) for a full test plan.

## Maintainers

[@jmpumuro](https://github.com/jmpumuro)

## Contributing

Questions and bug reports: [open an issue](https://github.com/jmpumuro/witness/issues). Pull requests are
welcome; read [CONTRIBUTING.md](CONTRIBUTING.md) first. Changes must keep the Node and Python runtimes in
agreement (`npm run test:runtime`) and the eval suite passing.

## License

[Apache-2.0](LICENSE) © Witness contributors
