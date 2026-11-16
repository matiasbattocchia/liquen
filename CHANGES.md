# Next batch: pages, and a login by WhatsApp

Decided 16 Nov 2026. All five are settled.

1. An agent publishes a folder as a page, for a WhatsApp conversation, through a `page`
   tool.
2. The page is a box: it loads only its own files and reaches nothing else.
3. Main serves the pages behind the edge, at `<base>/pages/<id>`.
4. A visitor logs in with WhatsApp: a link of their own in a direct chat, a code by DM in
   a group.
5. A page lives 30 days, a knob, and goes sooner when the agent takes it down.

## 1. The page tool

`page({to, files, dir?, title?, id?})` publishes; `page({remove})` takes a page down.

- **What it takes.** `files` names the app's files, relative to `dir`, which is where
  the shell stands when omitted. `index.html` is one of them, and the page opens on it.
  Each file goes through the session's files port, as `send`'s files do, so a path
  outside the agent's folders is refused the same way.
- **Limits.** At most 64 files and 25 MB in all. Each path is plain segments of letters,
  digits, dots, dashes and underscores, so it is a key the store takes as it is.
- **For whom.** `to` is a WhatsApp conversation the agent can read, by address or by
  name: a direct chat or a group. Any other service is refused; the login is
  WhatsApp's.
- **The answer.** The link, until when it is good, and who may open it. In a direct chat
  the link carries the person's token (4). Without `edge.publicUrl` the link is
  `http://localhost:<port>`, and the answer says it opens only on the org's machine.
- **Again.** `id` names a page of the agent's own: its files are replaced, its link and
  its people kept, and its days counted again from now.
- **Down.** `remove` takes a page's id or link; the agent's own pages only.
- **The gate.** `{ tool: "page", action: "ask" }` joins the default rules, beside `send`,
  since a page shows the org's work to people outside it.
- **The offer.** `page` joins `DEFAULT_TOOLS`. An org whose `config.yaml` lists `tools`
  adds it there.
- **The doc.** `src/seed/system/tools/page.md`.

## 2. The box

Every file of a page is served with headers that close it in:

- **It can't see out.** `default-src 'self'`, with inline script and style allowed: the
  page loads and fetches only its own files.
- **It can't see its neighbors.** `sandbox allow-scripts allow-forms allow-popups`,
  without `allow-same-origin`: the page runs in an origin of its own, so it can't read
  other pages, use the visitor's login, or touch the sign-in doors.
- **Nobody walks in without a key.** The files are served under a view key,
  `<base>/pages/<id>/<view>/<path>`: signed, bound to the page, good for 4 hours. A
  relative path inside the app resolves under the same key. The sandbox makes the
  page's own fetches cross-origin, so its files answer any origin, and the key in the
  path is their lock.
- **Nothing remembers it.** `no-store`, `noindex`, `no-referrer`, `nosniff`, and no
  framing by another site.

A page's script can still move its own window elsewhere. No header closes that, and the
tool doc says the page is a view of the conversation's work, never a place for secrets.

## 3. Main serves the pages

- **The edge.** `/pages/…` goes to `data/run/pages.sock` with the path as it came. Main
  serves the socket while it runs. Nothing there answers 502, as an ingest's does.
- **Where a page lives.** Its row is in the vault under `page:<id>`, owned by its agent,
  so removing the agent removes its pages. The row keeps the conversation, its kind,
  the account, the title, the files, the deadline, and the direct token's hash. The files
  are objects under `pages/<id>/`.
- **The sweep.** Main lets go of a page past its deadline, and of the files of a page
  whose row is gone, at boot and every hour.
- **The run log.** A login, a code sent, and each page opened are lines, with the page
  and the last four digits of the number.

## 4. The login

The login is a cookie that says "this is +54…", signed with a key the vault keeps
(`pages:sign`), good for 7 days, `HttpOnly`, `SameSite=Lax`, on `/pages`. It opens every
page meant for that number. Each time a page is opened, main checks the number belongs:

- **A direct chat**: the number is the conversation's.
- **A group**: the number is on its roster now, as the bridge reads it. A member who left
  no longer opens it. A roster that can't be read answers 503 and says to try again.

Without a cookie, or with one the page doesn't admit, the visitor logs in:

- **A direct chat's link** carries a token, good once for the life of the page. Opening
  the link shows the page's title and a button. The button posts the token, so a link
  previewer that only fetches spends nothing. A token spent, or the page opened on a
  second device, falls back to the code.
- **The code.** The page asks for the number, international format. Main checks it
  belongs before anything is sent, and only then DMs a 6-digit code from the page's
  account, through the bridge, with no line in the log: the agent never holds a code.
  The page answers the same whether or not one was sent: "If that number can open this
  page, a code is on its way." A code lives 10 minutes and takes 5 tries.
- **The caps.** One code per number a minute and 5 an hour, so nobody can make the
  account flood a member.

## 5. Days

`pages.days` in the catalog, 30 by default: how long a page lives from its publishing.
Read on each publish, so a change takes effect on the next page.
