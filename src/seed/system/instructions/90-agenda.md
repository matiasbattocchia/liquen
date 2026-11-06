---
kind: instruction
load: always
---
# Agenda

A line about a moment names it right after its status:
`- [ ] @7 Nov 17:30 Sam records the demo #studio (2 Nov, 8be1d0)`. The checkbox marks a
todo, `@` the moment, the `#tags` close the text, and the grounding closes the line. Leave
out the year and the nearest such date is meant; leave out the time and the line holds for
the whole day; `17:30-18:30` gives it an end.

A repeat follows the moment, which is then its first occurrence:
`- @3 Nov 2026 18:00 every Tue Sam's Spanish class (28 Oct, 3f9a2c)`. It says `every day`,
`every Tue Thu`, `every 2 weeks`, `every month`, `every last Fri` or `every year`, and
`until 15 Dec` ends it. `every 30 minutes` and `every 2 hours` step from the line's time,
and `from 9:00 to 18:00` keeps the steps inside those hours. A yearless first occurrence
turns into the coming year once half a year has passed, so a repeat that runs longer gives
it its year. A repeating line takes no checkbox: one box cannot say which occurrence is
done.

A reminder follows the moment and any repeat, and wakes you with the line when it comes
due: `- @7 Nov 17:30 remind 1 day before at 10:00 Sam records the demo (2 Nov, 8be1d0)`. It
says `remind` for the moment itself, `remind 1 hour before`, `remind at 9:00` or `remind 2
days before at 9:00`, and a line for the whole day names its time. A line without one wakes
nobody, and a done line reminds of nothing.

The `today` and `tomorrow` notes list each day: the calendar's events and the dated lines
of every doc you read, under the doc and heading they stand in, each repeating onto the day.
So a date worth seeing is a dated line, and it is in front of you on the day and the day
before. A reminder is for work of yours that comes due at a time: a message to send, a
payment to check, a chat to read. The line says that work; a meeting, a class or a
birthday with nothing for you to do takes none.

- A board is one file: its `##` headings are the columns, and a line moves between them as
  its work moves. A heading tags its block the way a `#tag` tags a line.
- A checkbox belongs to plain lists; on a board, the column is the status.
- A line moves in the turn its step's work is done, and when its moment changes it takes
  the new one, so the board says where everyone stands.
- A line that moves to a column whose step comes at a time takes that step's reminder in
  the same edit.
