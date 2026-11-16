---
kind: tool
---

Publish a folder as a page for a WhatsApp conversation: a web app the people there open in
their browser. The answer is its link; pass it on with `send`. In a direct chat the link logs
its person in at once. In a group, each member opens it with a code sent to their number, and
only while they are in the group. A page lives a set number of days, and `remove` takes it
down sooner.

The page is a box: it loads and fetches only its own files, so a library, a font or a data
file goes in the folder, never a link to elsewhere. Script and style run, inline or as files,
and relative paths work. It is a view of your work for the people of that conversation: never
put a secret in it.

- to: the WhatsApp conversation it is for, a direct chat or a group: its <conv> `address`, or
  its name
- files: the app's files, as paths relative to `dir`; `index.html` is one, and the page opens
  on it
- dir: the app's folder; where your shell stands when omitted
- title: what the page is called; its `index.html` title when omitted
- id: a page of yours to publish again, by its id or link: its files are replaced, its link
  kept, and its days counted again from now
- remove: a page of yours to take down, by its id or link; alone
