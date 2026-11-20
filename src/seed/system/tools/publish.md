---
kind: tool
---

Publish a folder as an artifact: a page, an API or an app that people open in their browser,
for WhatsApp conversations and for your principals, who are always on its list. This is how
you show work to people: never put it on a public host. The answer is the link, and one more
for each direct chat and principal, which logs its person in at once; pass them on with
`send`. Anyone else it is for opens it with a code sent to their number, and a group's
members only while they are in the group.

What the folder holds says what it is:
- `public/`: what it shows, opening on `public/index.html`. Copied as it is published, dot-named files left out; a library, a font or a data file goes in it, never a link to elsewhere, since the page loads and fetches only its own files.
- `server.ts`: its server, in Deno, answering every request `public/`'s files don't. It runs from the folder itself, so what it reads (a database, a model) stays beside it and is never copied. Its first lines: `import { serve } from "@liquen/liquen/artifact"; serve((req, visitor) => Response.json({ phone: visitor.phone }));`. `visitor.phone` is the number of whoever opened it, set by liquen alone. From the page, fetch it by a relative path: `fetch("api/search?q=…")` reaches the server as `/api/search`.
- both: an app.

The server can read and write its own folder and nothing else, reach only the `hosts` you name, and it runs no programs. For an API key, ask your principal for a token through `connect` and read it from its variable: it holds a stand-in, and the real key is added on its way to the host. `native` lets it load the native libraries npm packages ship (a database driver): they run outside those limits, so say it only when a package needs it, and the card tells your principal. Try it before publishing with `deno run -A server.ts`, which serves `public/` and the server at http://127.0.0.1:8000. Once published, what it prints is in `.artifact.log` in the folder; a server that stops is started again.

A folder is one artifact. Publishing it again replaces its files, starts its server anew, keeps its link, and counts its days again from now. The link is made from the title the first time; a title another artifact's link has already taken is refused. Your artifacts stand in your anchor, and `cancel` takes one down by its folder or its link. One in `shared/` is every agent's: build there what another agent will publish, the one that reads the conversations it is for. It is a view of your work for the people it is for: never put a secret in `public/`.

- path: the folder, below your own or below `shared/`
- with: the WhatsApp conversations it is for, direct chats or groups, each its <conv>
  `address` or its name; leave it out for your principals alone, and a later publish keeps
  the list unless this replaces it
- title: what it is called, and what its link is made from; its `index.html` title when
  omitted
- hosts: the hosts its server may reach, each a name (`api.voyageai.com`); a later publish
  keeps them unless this replaces them
- native: whether its server loads native libraries; false unless said, and kept by a later
  publish unless this says otherwise
