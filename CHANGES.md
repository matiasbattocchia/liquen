# Next batch

## `publish`: a folder is its page

The `page` tool becomes `publish`, and a page is a folder: one page per folder, its link
kept for as long as the folder is published.

- `path`: the folder. It lies below the agent's own folder or below `shared/`, never at the
  root of either, and never in `system/`. Its files go whole, dot-named entries and what
  lies in them left out; `index.html` is one of them, and the caps on files and bytes hold
  as they do now.
- `with`: the WhatsApp conversations the page is for, each an address or a name, each one
  the agent can read. Anyone in any of them opens it.
- `title`: as now.

The first publish of a folder needs `with`. Publishing it again replaces its files, keeps
its link and counts its days again; `with` left out keeps the list, said it replaces it. The
list is checked against the agent publishing, every time: the conversations kept must be
ones it can read.

The page records the agent that published it last: its view vouches for `with`, and a
group's roster is read through it. Any agent that reaches the folder may publish it again or
take it down: a page in an agent's folder is that agent's, and one in `shared/` is every
agent's.

The answer is the link, plus one link per direct chat that carries its own token: each logs
its person in once. A republish keeps a token not yet spent and mints one for a chat whose
token was. A code goes out from the account of the conversation that admits the number.

`files`, `dir`, `id` and `remove` go. `cancel` takes a page down, by its folder or its link.

## Pages stand in the anchor

The anchor gains a `pages` section: the live pages in folders the agent reaches, one line
each, with its folder, title, link, conversations and last day. It moves on a publish, a
cancel or a page running out.

```
pages — 1 page:
· shared/jurisprudencia — "Buscador" · https://new.liquen.dev/pages/… · with Lucas Manu, Estudio · until 2026-12-16
```

## Seeds and docs

- `system/tools/publish.md` replaces `page.md`. It says a page is how the agent shows work
  to people, never a public host, and that work another agent will hand on is built in
  `shared/`.
- `system/tools/cancel.md`: a page, by its folder or link.
- The defaults name `publish` in `DEFAULT_TOOLS` and in its `ask` rule. new's `config.yaml`
  follows.
- `RENDER.md` lists the `pages` section; `DESIGN.md` §9 and `PROJECT.md` follow.
