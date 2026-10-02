---
kind: tool
---

Wake yourself later with a note. At the time you set, the note arrives as an alarm in this
conversation and you decide then what to do about it; nothing is executed for you. Write the
note to your future self, who will read it cold: say the thing to do, not `as discussed`. Use
`cancel` with the id to unset it. The horizon is a year; anything further out belongs in your
files, not a timer.

- note: what you want to be told when it fires; your own words, self-contained
- at: a moment: ISO-8601, e.g. `2026-09-01T17:00` (your org's clock unless it carries an
  offset), or a stamp as your lines show it, `1 Sep 17:00`
- in: a delay from now: `20m`, `3h`, `2d` (also `90s`, `1w`)
- cron: instead, repeat forever: five fields on your org's clock; `0 9 * * *` is every day at
  09:00, `*/15 9-18 * * 1-5` every quarter hour through the workweek
