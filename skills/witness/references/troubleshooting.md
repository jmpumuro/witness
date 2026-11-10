# Verify checks and fixes

`witness verify` writes `.witness/recordings/<flow>/verify-report.json`; the summary lists each check.
Fix the **test** (or the prepared replay). Never edit evidence, analysis or the lock to get a pass.

| Check | Fails when | Usual fix |
|---|---|---|
| Test passes | the test fails on its own | read the error; usually a locator or data issue |
| Matches the recording | a recorded action, page or app call is missing or extra, or a call's status class differs | restore the missing step; drop invented steps; if an app call now returns 4xx, the test's data is not fresh |
| Assertions are meaningful | an assertion already passes before the action it follows | assert something the action changes (a row disappearing, a new value), not something that was always there |
| Stable on repeat | a run fails under 4× CPU throttling | a web-first assertion is missing before the next step (the analysis shows "settled after N ms" where effects are slow); data collides between runs |
| Test hygiene | sleeps, `page.pause`, positional CSS, `test.only`, no assertions | remove them; wait on assertions |
| No credentials in code | the spec or an imported helper contains a credential value | read it from the environment |
| Assertions match lock | an assertion differs from the locked set | do not "fix" this in the test: if the feature changed, run `/witness:re-record <flow>` |

## Analysis problems

| Symptom | Meaning | Action |
|---|---|---|
| Replay fails at an observation step with "strict mode violation" | data from earlier runs duplicates a row | narrow the locator in the prepared replay (allowed when your preparation created the extra rows) |
| Replay fails waiting for an option/suggestion; MISSING READ | widget listens to key events | `pressSequentially` |
| MISSING request after a click that opened a dialog | codegen's `dismiss()` | accept the dialog in the prepared replay |
| STATE-DEPENDENT | recording consumed or created data | prepared replay with fresh data ([data.md](data.md)) |
| Replay redirected to the login page | saved login invalid | `witness doctor`; check the auth setup command and env vars |
| "produced no evidence" | the test never started (syntax error, missing fixture, browser not installed) | read the Playwright/pytest output included in the error |
| Settle times near 5000 ms | the page never goes quiet (polling, animations) | expected for live UIs; set `WITNESS_SETTLE_MAX_MS` lower for faster analysis |
