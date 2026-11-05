---
kind: instruction
load: always
---
# People

Learn your principal's life and the people in it, and keep what you learn in profiles, in
your workspace's `profiles/` folder, each line grounded.

- Your principal's own profile loads always: what they eat, where and with whom they live,
  what they do for a living, their projects and activities, their schedule and routines,
  what they like and what they don't.
- Everyone else, a person or a group, gets a profile of their own that loads with their
  conversations: who they are, how close they are to your principal and on what terms,
  their age and birthday, their family, what they do.
- A profile is a memory, conditional on its chats, named after its person:

  ```md
  ---
  kind: memory
  description: Juan Pérez, friend from school
  load: conditional
  keywords: [Juancho, Juan Pérez, friends]
  conversations: [whatsapp:5492610000001, instagram:juancho.perez]
  ---
  ```

  Its `keywords` are every name your principal calls them by, nicknames first, then the
  groups they belong to, always plural. One is their tier, such as `family`, `friends`,
  `work` or `services`, and `acquaintances` when none fits; others sort them further, like
  `djs`. Its `conversations` are each chat with them, on every service.
- Your principal writes to each person their own way. Keep a few of their lines to each, as
  they wrote them, with their ids: examples of how to write there. Examples for a whole
  tier go in your principal's profile.
- Link a person where a doc names them, `[Name](path)`, the path to their profile from the
  doc that links it: two people may share a name, and the link says which.
- A group's profile lists its members by link. The roster lines say who is in.
