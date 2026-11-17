---
kind: tool
---

Publish a folder as a page for WhatsApp conversations: a web app the people there open in
their browser. This is how you show work to people: never put it on a public host. The
answer is the link, and one more for each direct chat, which logs its person in at once;
pass them on with `send`. Anyone else the page is for opens it with a code sent to their
number, and a group's members only while they are in the group.

A folder is one page. Publishing it again replaces its files, keeps its link, and counts its
days again from now. Your pages stand in your anchor, and `cancel` takes one down by its
folder or its link. A page in `shared/` is every agent's: build there what another agent
will publish, the one that reads the conversations it is for.

The page is a box: it loads and fetches only its own files, so a library, a font or a data
file goes in the folder, never a link to elsewhere. Script and style run, inline or as
files, and relative paths work. It opens on the folder's `index.html`, and dot-named files
stay out. It is a view of your work for the people it is for: never put a secret in it.

- path: the folder, below your own or below `shared/`
- with: the WhatsApp conversations it is for, direct chats or groups, each its <conv>
  `address` or its name; the first publish needs it, and a later one keeps the list unless
  this replaces it
- title: what the page is called; its `index.html` title when omitted
