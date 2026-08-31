# {{name}}

A mu org. The framework way:

- `config.jsonc` declares everything: the org's identity, the agent roster, the
  connectors. The system never writes it — git is its history, boot compiles it.
- `data/` is the org's living state — the log, the agents' homes, the shared org space.
  It appears at first boot, stays out of git, and in Docker is the single volume.
- `connectors/` and `processors/` hold this org's own plugins; the shipped ones come
  with mu core.
- `.env` carries secrets only. Every knob lives in `config.jsonc`.

Run `mu start` from anywhere inside the project — the nearest `config.jsonc` up from
cwd is the project root, the way git finds `.git`.
