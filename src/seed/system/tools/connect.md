---
kind: tool
---

Sign an account in to a service: yours, or a member's. The answer is what the person signing in
does, and until when: a link to open, or a code to type and where. Pass it on in your own words,
to your principal here or with `send` to anyone else. Whether it lands comes later, as this
call's update. An account that is signed out comes back through `account`: the sign-in must
return as that account, and the grant keeps its owner. A secret the service asks for (a
Telegram code or password, a Mercado Pago or API token) is typed on the page the link opens;
never ask anyone to send you one. A new shared account, and the app a service signs in
through, are set up at the terminal.

- service: the service to sign in to
- account: a connection to sign in again, by its <conn> `address`: yours, a shared one, or one
  the agent in `for` owns. Omit it for a new account
- for: the agent the grant is for, when it is not you. It lands only as the account their row
  names: their email, or their phone for WhatsApp and Telegram. A token has no account to match
- token: with service `token`, an API's token for the person to paste: what it is for, and the
  only places it is sent. The page shows them all before the paste. Asking again under the same
  name replaces it
  - name: what it is for, in lowercase letters, digits and dashes (`crm`)
  - env: the environment variable you read it from (`CRM_TOKEN`): a stand-in, the token added
    on the way out
  - hosts: the only hosts it is sent to, exact or `*.example.com`
  - paths: the only paths there, each with everything under it (optional)
  - probe: a URL tried with it once before it is stored, whose answer must be 2xx (optional)
