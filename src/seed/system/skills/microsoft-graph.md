---
kind: skill
description: Read and act on a connected Microsoft 365 account — Outlook mail and
  calendar, Teams chats and channels — through the Graph API with `fetch`. Use when
  `$MICROSOFT_GRAPH_TOKEN` is set.
---
# Microsoft Graph

A connected Microsoft account shows up in your environment as `$MICROSOFT_GRAPH_TOKEN`.
It is a handle, not a secret, and it opens exactly one host: `graph.microsoft.com`. Send
it as a bearer with `fetch`, the same way as any API credential:

```sh
fetch -H "Authorization: Bearer $MICROSOFT_GRAPH_TOKEN" "https://graph.microsoft.com/v1.0/me"
```

Everything below is a path under `https://graph.microsoft.com/v1.0`. Set
`G="https://graph.microsoft.com/v1.0"` and `A=(-H "Authorization: Bearer $MICROSOFT_GRAPH_TOKEN")`
once in a call, then `fetch "${A[@]}" "$G/me/messages"`.

## Reading

Ask for the fields you need with `$select`, cap the page with `$top`, and filter or
order server-side; a whole message with its HTML body is long, and the default page is
ten items.

```sh
# the inbox, newest first, one line each
fetch "${A[@]}" "$G/me/mailFolders/inbox/messages?\$top=20&\$select=id,from,subject,receivedDateTime,isRead&\$orderby=receivedDateTime%20desc"
# one message, as text
fetch "${A[@]}" -H "Prefer: outlook.body-content-type=text" "$G/me/messages/<id>?\$select=subject,from,toRecipients,body"
# search across the mailbox
fetch "${A[@]}" "$G/me/messages?\$search=%22from:ana%20invoice%22&\$select=id,subject,from"
# the week's calendar, expanded (recurring events become instances)
fetch "${A[@]}" -H "Prefer: outlook.timezone=\"UTC\"" "$G/me/calendarView?startDateTime=2026-09-21T00:00:00&endDateTime=2026-09-28T00:00:00&\$select=subject,start,end,location,organizer&\$orderby=start/dateTime"
# chats, then a chat's messages
fetch "${A[@]}" "$G/me/chats?\$expand=members&\$top=20"
fetch "${A[@]}" "$G/me/chats/<chat-id>/messages?\$top=20"
# teams and channels
fetch "${A[@]}" "$G/me/joinedTeams"
fetch "${A[@]}" "$G/teams/<team-id>/channels"
fetch "${A[@]}" "$G/teams/<team-id>/channels/<channel-id>/messages?\$top=20"
```

A page that has more carries `@odata.nextLink`: a complete URL, fetch it as it is for
the next page. `$` in a query must be escaped in double quotes (`\$top`) or the shell
eats it.

## Acting

Mail and Teams are conversations of yours, not Graph calls: what arrives in the account's
Inbox and what leaves its Sent Items, the member's chats and the channels of their teams,
are in your log as `<conv>` lines on the account (a mail's other party with the subject
as `thread`, a chat by its id, a channel by `Team / Channel`), and you write them with
`send` — `to` an address or a name, `subject` for a new mail thread, `re` to answer a
line — the same way as any other conversation. Graph is for what the log does not carry:
searching the mailbox, flags and folders, the calendar, a chat's members, a team's roster.

```sh
# create an event
fetch "${A[@]}" -X POST "$G/me/events" -d @- <<'EOF'
{"subject": "…", "start": {"dateTime": "2026-09-24T15:00:00", "timeZone": "UTC"},
 "end": {"dateTime": "2026-09-24T15:30:00", "timeZone": "UTC"},
 "attendees": [{"emailAddress": {"address": "ana@example.com"}, "type": "required"}]}
EOF
```

A `201` or `204` is success — a `204` has no body. `PATCH` edits (`{"isRead": true}` on a
message, new times on an event); `DELETE` removes.

## What a 403 means

The grant carries only the permissions the account holder approved at sign-in:
`Mail.Read`, `Mail.Send`, `Calendars.ReadWrite`, `Chat.ReadWrite`, `ChannelMessage.Send`,
`ChannelMessage.Read.All`… A 403 with `Authorization_RequestDenied` or `AccessDenied`
means the grant lacks the one this call needs; say which, and the person who connected
the account can approve it. Reading channel messages is a permission a tenant's admins
grant, never the member alone. Nothing here can be widened from your side.
