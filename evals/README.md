# Witness evals

Three small demo apps in different domains, each with CRUD flows and the edge cases that make recorded tests
fail in real projects, and an eval harness that runs the whole Witness pipeline on them in both languages.

| App | Domain | Port | Edge cases it exercises |
|---|---|---|---|
| `examples/shop` | e-commerce | 4101 | single-use coupons, delayed toast, cookie overlay after a delay, repeated row buttons, confirm dialog, duplicate-name 409, validation 400 |
| `examples/clinic` | healthcare scheduling | 4102 | inline validation then correction, unique email 409, **keyup-only autocomplete** (`fill()` doesn't trigger it), consumable time slots, icon-only button without a label |
| `examples/library` | lending | 4103 | net-neutral flow (control), tabs and pagination, loan limits, **text computed from the current date** |

Each app is dependency-free Node, in-memory, and resets on restart (or `POST /__test/reset` with `TEST_MODE=1`).
`npm run apps` starts all three. Demo logins are in `examples/<app>/e2e/.env.example`.

## Cases

| Case | What it checks |
|---|---|
| `shop-apply-coupon` | state-dependent data detected (409), overlay/typo/focus steps optional, delayed effect caught, correct top checkpoints; 5 mutants |
| `shop-admin-product` | codegen's dismissed dialog detected (missing DELETE), duplicate-name divergence on re-run, unique-name golden passes vacuity with run-specific values |
| `clinic-new-patient` | validation flow, unique-email divergence, three observation clicks ranked |
| `clinic-book-appointment` | missing read → `pressSequentially`, consumable slot freed through the API, ambiguous locator narrowed |
| `library-borrow-return` | control case: repeatable as recorded, no preparation |
| `library-loan-status` | time-dependent text flagged, golden pins `page.clock`; a vacuous-assertion mutant |

Each case runs: simulate the human recording (raw codegen output + HAR) → `witness import` → `witness analyze`
(checked against `case.json`) → analyze the prepared replay → `witness verify` the golden test (must pass) →
`witness lock` → `witness verify` each mutant (must fail on the named check).

```bash
npm run eval -- --lang both                     # everything (≈20 min)
npm run eval -- --lang py --case shop-apply-coupon
PW_CHANNEL=chrome npm run eval                  # use an installed Chrome
```

Results are written to `evals/results/`.

## Evaluating the agent (not just the runtime)

The golden tests show what a good agent produces. To grade an actual agent run:

```bash
# 1. Prepare the case up to the analysis (recording imported and analyzed in the example project)
npm run eval -- --lang ts --case shop-apply-coupon --stop-after analyze

# 2. Let the agent continue the workflow from the analysis, in the example project
cd examples/shop/e2e
claude --plugin-dir ../../.. -p "A recording for flow apply-coupon has been imported and analyzed \
  (.witness/recordings/apply-coupon). Continue the witness workflow from step 3: prepare data if the \
  analysis requires it, choose checkpoints, generate the test in tests/, verify and lock. Then report."

# 3. Grade the agent's test with the same checks as the golden one
mkdir -p /tmp/candidates/shop-apply-coupon && cp tests/apply-coupon.spec.ts /tmp/candidates/shop-apply-coupon/
cd ../../.. && npm run eval -- --lang ts --case shop-apply-coupon --candidates /tmp/candidates
```

Things to look at beyond pass/fail: did the agent pick the same checkpoints as the golden test (or justify
others), reuse `tests/support/` helpers, avoid editing evidence, and stop when verify could not pass?
