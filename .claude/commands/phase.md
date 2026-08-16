---
description: Build a single numbered phase from the spec, with scope guarding
---

Read `docs/00-INDEX.md` and identify phase $ARGUMENTS in the merged build order.

Read whichever spec documents cover that phase. Respect the precedence rules in the index.

Then:

1. Enter plan mode and show me the plan before writing any code. Include which files you will create or modify, and flag anything in the spec that is ambiguous or that you disagree with.
2. Wait for my approval.
3. Build **only** phase $ARGUMENTS. Do not begin the next phase.
4. Run the relevant checks — `npm test` for engine work, `npm run build` for anything that touches the app.
5. Stop and report: what changed, what I should verify manually, and anything in the spec that turned out to be wrong or underspecified.

Do not modify files in `docs/` unless I explicitly ask. Do not restructure existing working code to suit the new phase without telling me first.
