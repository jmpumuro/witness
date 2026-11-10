# Security

Witness runs on developers' machines and in CI, inside projects that hold test credentials. This is what it
does and does not do.

## What the runtime does

- Runs `playwright codegen`, `npx playwright test` or `pytest` in the project directory, with a copy of the
  project's tests in `.witness/tmp/` (Node) or a pytest plugin loaded with `-p` (Python). User files are never
  modified by the runtime.
- Talks only to the app under test (through the browser) and to nothing else. No telemetry, no uploads.
- Reads the project's `.witness/config.json` and writes under `.witness/` only.

## Credentials

- Credentials come from environment variables. The config stores variable **names**, never values.
- `witness verify` fails a test whose source, or any local file it imports, contains the value of a configured
  credential variable.
- Request bodies and response excerpts kept as evidence are redacted for environment values whose names look
  secret (`*PASS*`, `*SECRET*`, `*TOKEN*`, `*KEY*`, `*PWD*`) and for JSON fields such as `password` or `token`.
- Saved logins (`playwright/.auth/`) and raw recordings (`.witness/recordings/`) must stay out of git; `witness
  setup` adds the Witness paths to `.gitignore`.

## Test environments only

Witness replays flows that change data (it is how it finds state-dependent steps). Point it at a test or local
environment, never production.

## Reporting a vulnerability

Please open a private security advisory on the repository rather than a public issue.
