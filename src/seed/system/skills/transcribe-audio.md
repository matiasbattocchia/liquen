---
kind: skill
description: Transcribe an audio FILE met in the workspace (a download, an export) with the
  local qwen-asr binary. NOT for chat attachments — voice notes transcribe automatically.
---
Voice notes in conversations need nothing from you: the harness transcribes them and the
words arrive as a `<transcript>` line a little after the note — up to a few minutes for a
long one. Be patient; never run this on an attachment.

For an audio file you met anywhere else (a download, an export, a recording in the
workspace), the same local model is one command away — any format ffmpeg reads:

```sh
../../../processors/qwen-asr/transcribe.sh < the-file.mp3
```

(That path is the harness's `processors/`, three up from your folder; if it does not resolve
from where you are, find it and use the path you find.)

(Expect it to take roughly the audio's own duration; run it in the background if the
file is long.)
