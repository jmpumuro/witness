---
description: Re-record an existing flow (the feature changed) and update its test and locked checkpoints
argument-hint: "<flow-name>"
---

Use the **witness** skill to re-record the flow: $ARGUMENTS

Follow its "Re-record" section: reuse the role and start path from `.witness/flows/<flow>.json`, record
with `--replace`, then analyze, generate, verify and lock again, updating the existing test file. Report
what changed in the steps and, separately, in the checkpoints. If no flow name was given, list the
recorded flows (`witness status`) and ask which one.
