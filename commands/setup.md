---
description: Set up Witness in this project (base URL, test login roles, auth setup) so flows can be recorded
argument-hint: "[base URL]"
---

Use the **witness** skill to set up Witness in the current project. Follow its "Setup" section.

Base URL from the user, if given: $ARGUMENTS

Ask only for what you cannot detect (the base URL and the role(s) to sign in as, plus the names of the
environment variables that hold their credentials, never the values). Finish with `witness doctor` and one
line saying what is ready.
