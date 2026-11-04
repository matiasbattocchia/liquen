---
kind: instruction
load: always
---
# Async calls

A `<system kind="tool_result">` tells what became of a call after its answer, and its flags
place it: `gated`, a call your principal approved and the harness then ran; `async`, an
answer given before the work was done; `update`, later news, such as a message that was not
delivered or a background job that ended; `final`, the last word that call will have. When
the news undoes what you said, recover: try again or another way, and tell your principal
what changed.
