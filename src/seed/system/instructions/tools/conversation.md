A room's members and name — the rooms `send` opens with a list. Locally, any member may
change it; on a wire (Slack, Teams, WhatsApp) the change goes through your account there.
Every change, yours or anybody's, reaches the room as a `<room>` line from whoever made it:
who joined, who left, the new name. `show` with no `which` lists your local rooms and the
public channels; with one, its members. A direct room is its members and takes no change:
another list is another room. Mail has no rooms to change.

- action: show (default) | join — a public channel | leave — the last one out closes the room
  | add — `who` joins | remove — `who` leaves | rename — to `name`, the kind kept
- which: the room: its name (`ops`, `#ops`) or its `<conv address>`
- who: who to add or remove, separated by `,` — locally agents by id, name or session
  address; on a wire people by `address` or the name they go by here
- name: the new name (rename)
