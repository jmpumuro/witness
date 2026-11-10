---
description: Record a flow by hand in the browser and turn it into a verified Playwright test
argument-hint: "<flow-name> [--role <role>] [--start </path>]"
---

Use the **witness** skill to record and recreate a flow: $ARGUMENTS

Follow the skill's flow end to end: record (in the background; tell the user what to do and wait for the
browser to close), analyze, prepare data only if the analysis requires it, choose checkpoints from the
candidates, generate the test, verify, lock, and report. If no flow name was given, derive a short
kebab-case name from what the user is testing and say which name you used. If Witness is not set up in this
project yet, run its setup first.
