# Contributing

Thanks for helping. A few principles keep Witness trustworthy:

1. **The recording is the source of truth.** Features must not let the agent invent behaviour or loosen checks.
2. **Deterministic work is code; judgment is in SKILL.md.** If a rule can be checked mechanically, check it in the runtime.
3. **Both runtimes agree.** Analysis and verification logic exists in Node (`lib/*.mjs`) and Python (`witness_py/*.py`) and must produce identical output.

## Layout

```
skills/witness/SKILL.md            the workflow the agent follows (portable Agent Skill)
skills/witness/references/         loaded on demand by the agent
skills/witness/runtime/node/       CLI + instrumentation shim for @playwright/test
skills/witness/runtime/python/     CLI + pytest plugin for pytest-playwright
skills/witness/runtime/conformance shared test vectors (expected output from the Node implementation)
commands/                          thin slash-command wrappers (Claude Code)
examples/                          three demo apps + example test projects (TS and Python)
evals/                             end-to-end eval cases, mutants and the harness
```

## Workflow

```bash
npm install && npx playwright install chromium
pip install pytest-playwright && playwright install chromium
npm run test:runtime                  # unit + conformance, both runtimes
npm run eval -- --lang both           # full pipeline on all cases (≈20 min)
npm run eval -- --lang ts --case shop-apply-coupon
```

Set `PW_CHANNEL=chrome` to use an installed Chrome instead of Playwright's bundled browser.

## Changing analysis or verification logic

1. Change both `runtime/node/lib/*.mjs` and `runtime/python/witness_py/*.py`.
2. Run the evals with `--keep`, then `npm run conformance` to regenerate vectors from fresh evidence.
3. `npm run test:runtime` must pass in both languages. Review the vector diffs: they are the behaviour change.

## Adding an eval case

`evals/cases/<app>-<flow>/` with:

- `case.json`: app, flow, role, start path, story, edge cases, and expectations for `analysis` (raw) and `prepared`;
- `recording/<ts|py>/raw...`: what codegen would emit; optional `human...` when the human did something codegen
  records differently (accepting a dialog, typing key by key); optional `prepared...`;
- `golden/<ts|py>/`: the test a good agent should produce (must pass verify);
- `mutants/<ts|py>/` + `"mutants": {"name": "<check that must fail>"}` in case.json.

Recordings may use `{{OVERDUE_TEXT:<iso>}}`, `{{DAYS_SINCE:<iso>}}`, `{{DAYS_UNTIL:<iso>}}` for date-dependent text.

## Adding a language (Java, .NET, ...)

1. An instrumentation layer that writes the evidence format (`schema/evidence.schema.json`): per-step aria
   snapshots, target description and candidates, requests, dialogs, assertions, vacuity results.
2. A CLI with the same commands, reusing the analysis/verify logic (port it, then pass the conformance vectors).
3. `references/<language>.md` with idioms, and example projects for the three demo apps.
