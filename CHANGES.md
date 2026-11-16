# Next batch

A sign-in page: Telegram, Mercado Pago and pasted tokens sign in through `connect`, the
secret typed on a page main serves and never seen by the model.

1. **The tool offers what main can sign in.** The `service` enum is the keys of the flows
   main hands its table of sign-ins, and the call is checked against the same list, so
   adding a flow adds the service. The doc's line says "the service to sign in to" and
   names none. The two constant lists of services go.

2. **A page is a link.** A page flow is a link flow whose handler answers on its own
   socket: `GET /start?ticket=` draws a form, and `POST /start` takes it. One module draws
   every page: plain HTML, no script, every value escaped, sent `no-store`, with no
   referrer, no framing, and a policy that loads nothing and posts only to itself. The
   page names whose grant it makes. A refusal from the judge settles the ticket, as on
   every flow; any other failure draws the form again with the reason, and the ticket
   stays open until it lapses. A flow can say it declares no connection (`token`).

3. **Mercado Pago.** The page asks for the access token. `GET /users/me` vouches for the
   user id, and for the email a grant for another agent is matched by. The grant and its
   note are written by the CLI door's path.

4. **Telegram.** The page asks for the phone number (filled from the row when it holds
   one), then the code Telegram sends, then the two-step password when the account has
   one; a wrong code or password asks again. The sign-in runs in main, the library loaded
   only then, and is held in memory: a restart begins the page again. It refuses without
   the app in the vault. The account's id pins a reconnect, and its phone matches a grant
   for another agent. The grant is written by the CLI door's path.

5. **Pasted tokens.** The call carries `token: {name, env, hosts, paths?, probe?}`,
   checked as the CLI checks them before a ticket opens. The page shows, before the
   paste, the variable the agent reads, every host and path the token may be spent
   toward, and whose it is. The probe runs when asked. The row is written by the CLI
   door's path, keyed by the token's name, and declares no connection. A token is the
   caller's or `for`'s, with no handle to match, since it is capability, not identity; a
   shared one stays the CLI's.

6. **Docs.** The tool doc, CONNECTORS (the sign-in passage), DESIGN (every sign-in is
   main's), RENDER if a line changes, PROJECT.
