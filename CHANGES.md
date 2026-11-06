# Next batch: storage

Decided 2, 3 and 6 Nov 2026. The object store the log guards is in (PROJECT.md, "Media is
kept in an object store"); what is left of it:

## 1. The policy on `storage.objects`

On Postgres the check is the database's: a policy on `storage.objects` lets the agent read
an object when an event it can read references it, an `EXISTS` over `refs` joined to its
view. On SQLite and files the door's own check stands.

## 2. A trial on R2

An org runs on R2 for a while, `deployment.storage` naming the bucket. First the S3 suite
against a bucket made with wrangler or the Cloudflare account (`LIQUEN_TEST_S3`).
