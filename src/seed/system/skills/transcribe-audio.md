---
kind: skill
description: Transcribe an audio file you met in the workspace, a download or an export,
  with the org's own audio processor. Not for chat attachments; voice notes transcribe
  on their own.
---
# Transcribe audio

Voice notes in conversations need nothing from you: the harness runs them through the
processor itself and the words arrive as a `<transcript>` line a little after the note,
up to a few minutes for a long one. Be patient; never run this on an attachment.

For an audio file you met anywhere else, a download, an export, a recording in the
workspace, the same processor is one command away. It lives under the org's
`processors/` folder, takes audio bytes on stdin and prints the transcript on stdout, in
any format ffmpeg reads:

```sh
ls ../../../processors                          # which processors this org has
../../../processors/<name>/transcribe.sh < the-file.mp3
```

An empty `processors/` means this org transcribes nothing locally. Expect a run to take
roughly the audio's own duration; run it in the background when the file is long.
