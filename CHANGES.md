# Next batch: who steers an agent, and through which connection

Decided 14 Nov 2026. Two things are independent: who steers an agent, and what kind of
connection it rides. All seven below are settled.

1. An agent's principals are a list of any length. None means nobody steers it; one makes
   it that person's augmented self; many make it a team's.
2. A connection is owned or shared. Owned is one agent's world, read by it alone; shared
   is the org's, read by every agent. A Slack bot is shared only, a Slack user grant owned
   only; a WhatsApp number, a Telegram account, a Google account and a Microsoft account
   either.
3. Self-talk steers on an owned connection only.
4. A DM with an owned connection steers its agent when the sender is one of its
   principals.
5. In a workspace, a DM with a shared connection steers the sender's own agent, when that
   agent runs and counts the sender among its principals. Any other DM is the shared
   inbox.
6. In a workspace, a room on a shared connection named after an agent steers that agent,
   whatever it owns elsewhere.
7. A shared Google or Microsoft account is mail and calendar, as Google's already is: a
   shared Microsoft account's Teams chats go unread, so Teams is owned only.

Slack and Teams are workspaces: everyone in one is a colleague, so a shared connection's
DMs and rooms can steer. WhatsApp, Telegram and Google reach anyone, and a shared account
there stays the shared inbox it is. With Teams owned only, the shared connection that
steers is the Slack bot.

The term is shared: docs, CLI output and comments say it where they said org account.

## 1. Owned and shared, per service

`liquen connect slack app --bot` lands the bot shared and takes no agent; a bot row with an
owner is refused at connect. Every door that took `--org` takes `--shared`. A shared
Microsoft account holds no Teams subscription, and its mail and calendar are read as they
are now. With no shared Teams account, Teams holds no steering room: the `rooms` branch of
`chatSurfaces`, `adoptable`, `leftRooms`, `letGo` and the channel listing's `steer` go.

A Teams account that someone needs shared is reviewed when that need is real.

## 2. Self-talk and DMs on an owned connection

As the code stands, with owned bots gone: the `self` branch of the `aliases` view, the
WhatsApp DM by the principal's number, and `mirrors.dms` on an owned Teams or Telegram
account. A Slack user grant records its self-DM alone.

## 3. A DM with the shared bot steers the sender's own agent

The sender's own agent is the one the classifier stamps on their line: a member's grant
row, or the email on their Slack profile against the roster. The DM is that agent's mind
surface: hidden from every agent, copied into `mind@<agent>`, answered through the bot.

- The bot's ingest records the `im` on the shared bot row, `mirrors.dms` member →
  channel, the first time a member writes there.
- The `aliases` view gains the branch: on a live shared connection, each recorded DM whose
  member counts among the principals of the agent of the same name.

A sender who is no member, or whose agent does not run or does not count them, stays in
the shared inbox.

## 4. A steering room on a shared connection, whatever the agent owns

`adoptRoom` drops its check that the agent owns no account; the view's `rooms` branch
reads as it does. An agent may hold its own lines and be steered from a shared room: a
support agent owns its WhatsApp number, so customers reach it alone, and the team steers
it from `#support`. Who steers it is `principals`, set by hand; when absent, the
derivation stands (an agent that owns a connection steers itself, one that owns none is
steered by the org's people).

Whoever writes in a steering room steers, save a member who is not among the agent's
principals. Who may enter the room is the workspace's rule: a person's augmented self is
steered from a room that holds that person alone.

The "What is open" item on a steering room that cannot tell a person's agent from an
org's closes: any agent may have one.

## 5. Existing orgs

`new` holds no owned Slack bot and no live shared Microsoft account: its Microsoft account
is owned and revoked, its shared WhatsApp number revoked. `vibes` holds no connection.
Nothing there changes shape.

## 6. Docs

DESIGN §4 takes the two axes: "Principal-DM bindings per platform", the surface table,
"Whose account" and "Who steers". The connect doors' help text, and CONNECTORS where it
names an owned bot or a shared Teams account.
