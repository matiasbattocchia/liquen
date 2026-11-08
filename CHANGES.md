# Next batch: what the harness derives and sends is kept

Decided 8 Nov 2026.

## 1. A long transcript keeps its whole text as an object

A processor's output is capped where it renders: the `<transcript>` carries its first few
KB, and the transcript event names the whole output as a kept object,
`storage://media/<hash>.txt`, content-named like any other. The event references it, so
the agent may read it (`aread storage://…`, through its door) and the store keeps it as
long as the event stands. A note forwarded again takes both, the words and the object.
The same shape serves a caption or a document's extraction when those processors come.

## 2. A sent file is kept when it is sent

`send({files})` and a tool's attachments keep a file of the agent's ground the moment it
is named: the part in the log and in `<msg>` is its `storage://` uri, so a connector, on
the edge as well, sends a kept object and the history shows the file as it was sent. The
path the agent named, relative to its folder (`report.pdf`, `org/plan.pdf`), rides
`extra`; no host path enters the log. The local adapter and the sandbox's (`gatewayFiles`)
then share one resolve, each giving its own reader and the roots it allows. Whether the
pin on a tool's attachment (`extra.media`) still earns its place is decided there.
