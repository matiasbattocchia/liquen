# {{name}}

A mu org. The framework way:

- `config.jsonc` declares everything: the org's identity, the agent roster, the
  connectors. Only the setup doors write it — `mu init` made it, `mu connect` declares
  the connection a grant earns. Git is its history, and boot compiles it.
- `data/` is the org's living state — the log, the agents' homes, the shared org space.
  It appears at first boot, stays out of git, and in Docker is the single volume.
- `connectors/` and `processors/` hold this org's own plugins; the shipped ones come
  with mu core.
- `.env` carries secrets only. Every knob lives in `config.jsonc`.

Run `mu start` from anywhere inside the project — the nearest `config.jsonc` up from
cwd is the project root, the way git finds `.git`.
