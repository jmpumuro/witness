# Changelog

## 0.1.0 — 2026-11-10

First release.

- `/witness:setup`, `/witness:record`, `/witness:re-record`.
- Runtimes for @playwright/test (Node) and pytest-playwright (Python) with identical analysis (conformance vectors).
- Raw replay analysis: per-step effects, verified unique locators, checkpoint candidates with attention and stability
  signals, divergence from the recording (state-dependent data, missing reads, dismissed dialogs), overlays,
  time-dependent text, observed app API calls.
- Verify: fidelity to the replay, vacuity (with run-specific value substitution), repeat runs under CPU throttling,
  lint, credential scan, assertion lock.
- Demo apps (shop, clinic, library), 6 eval cases in both languages, 6 mutants per language.
