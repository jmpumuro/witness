# Witness

[![CI](https://github.com/jmpumuro/witness/actions/workflows/ci.yml/badge.svg)](https://github.com/jmpumuro/witness/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

Record a flow by hand in the browser; get a verified, repeatable Playwright test (Claude Code plugin)

You click through a feature once. Witness replays your recording, measures what every step did, and Claude
turns it into a clean Playwright test (TypeScript or Python). Before handing it over, Witness checks that the
test:

- performs the same actions and app calls as your recording;
- only asserts things that were false before the action they follow;
- passes repeatedly under 4× CPU throttling;
- has no sleeps, positional CSS or credentials.

Verified assertions are then locked: only a re-record changes them.

## Install

```text
/plugin marketplace add jmpumuro/witness
/plugin install witness@witness
```

From a shell: `claude plugin marketplace add jmpumuro/witness && claude plugin install witness@witness`.
For a team, add `--scope project` to the install. To update: `claude plugin update witness@witness`.

Requirements: Claude Code on a machine with a display (recording opens a browser), and either Node 18+ with
`@playwright/test` ≥ 1.49 or Python 3.10+ with `pytest-playwright`, plus a test account for your app.

## Usage

```text
/witness:setup http://localhost:3000
/witness:record apply-coupon
```

A browser opens, signed in as your test user. Do the flow and close the browser. You get
`tests/apply-coupon.spec.ts` and a short report of which checkpoints were chosen and why.

| Command | What it does |
|---|---|
| `/witness:setup [base URL]` | Base URL, test login roles (credentials from env vars only), auth setup |
| `/witness:record <flow> [--role <role>] [--start </path>]` | Record → analyze → generate → verify → lock |
| `/witness:re-record <flow>` | Record again after the feature changed; updates the test and its lock |

The test is plain Playwright and runs without Witness. Witness also commits `.witness/config.json` and
`.witness/flows/<flow>.json` (locked checkpoints); raw recordings stay gitignored.

## Limits

Witness says so instead of writing a fragile test when a flow needs MFA or email-link login, third-party
pages (OAuth, payments), canvas/WebGL, environment-specific feature flags, or data the app cannot create.
Not supported yet: browser extensions, async Python tests, locators inside iframes, and TypeScript projects that
import Playwright through a custom path alias.

## Security

Credentials come from environment variables only, saved request data is redacted, and nothing is sent anywhere
except the app under test. See [SECURITY.md](SECURITY.md).

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the layout, tests and eval
suite.

## License

[Apache-2.0](LICENSE) © Witness contributors
