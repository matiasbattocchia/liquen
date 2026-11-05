---
kind: skill
description: The shape of a profile, a person's or a group's, and the header that ties it
  to their chats. Use before writing a new one.
---
# Profile

One file per person or group, in your workspace's `profiles/` folder, named after them:
`profiles/juan-perez.md`. A person's:

```md
---
kind: memory
description: Juan Pérez, friend from school
load: conditional
keywords: [Juancho, Juan Pérez, friends]
conversations: [whatsapp:5492610000001, instagram:juancho.perez]
---
# Juan Pérez

- Friend since school; they talk almost daily. (4 Nov, 8be1d0)
- Born 12 Mar 1990. (4 Nov, 41c2aa)
- Lives in Mendoza with [Lucía](handle). (4 Nov, 41c2aa)
- Works as a sound engineer. (2 Nov, 3f9a2c)

## How your principal writes to him

- "dale, el sábado llevo el bajo" (8be1d0)
- "jaja no llego, arranquen sin mí" (41c2aa)
```

A group's adds its members:

```md
---
kind: memory
description: the band's WhatsApp group
load: conditional
keywords: [the band, rehearsal]
conversations: [whatsapp:120363000000000001@g.us]
---
# The band

- Rehearses on Thursdays at 20:00. (2 Nov, 3f9a2c)

## Members

- [Juan Pérez](handle), guitar
- [Pablo Díaz](handle), drums
```

A profile is a memory: keep it under its budget, rewrite a fact that changed, and close
each line with its grounding.
