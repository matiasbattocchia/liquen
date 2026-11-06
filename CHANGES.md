# Next batch: storage

Decided 2, 3 and 6 Nov 2026. The object store the log guards is in (PROJECT.md, "Media is
kept in an object store"); what is left of it:

## 1. A trial on R2

An org runs on R2 for a while, `deployment.storage` naming the bucket. The S3 suite passes
against the `liquen` bucket, and `new` keeps its files there since 6 Nov; what it kept
before stays on disk, unreachable, by choice.
