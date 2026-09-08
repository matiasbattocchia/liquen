"""Harbor adapter for mu (BaseInstalledAgent).

The container gets a Deno binary and this checkout's source, and an org scaffolded by
`mu init` under /installed-agent — the agent is the container's user, the catalog carries
the model and effort Harbor asks for. A trial is one `mu cli` run in its own session: it
stands in the task's working directory and MU_DIR names the org. stdout is the closing
transcript; the org's log is copied out beside it so a trial can be audited event by event.
"""

import re
import shlex
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import override

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.trial.paths import EnvironmentPaths

REPO = Path(__file__).resolve().parents[3]
INSTALL = "/installed-agent"
MU = f"{INSTALL}/mu"
ORG = f"{INSTALL}/org"
DENO = f"{INSTALL}/deno"
DENO_DIR = f"{INSTALL}/deno-cache"

# Under the wall: a maxed turn must finish inside Harbor's 900s agent kill with room for
# the continuation the harness owes it, and `mu cli --timeout` must fire before the kill
# so the log is copied out.
TIMEOUT_S = 840
MAX_TOKENS = 32000

# The trial's shells see the org's keys, never inherit the harness's.
SHELL_ENV = {"DENO_DIR": DENO_DIR, "DENO_NO_UPDATE_CHECK": "1", "MU_DIR": ORG}


def host_deno() -> Path:
    found = shutil.which("deno")
    if not found:
        raise RuntimeError("deno not on PATH — the container gets the host's binary")
    return Path(found).resolve()


def scaffold_org(into: Path, agent: str, model: str, effort: str | None) -> Path:
    """`mu init` on the host, then the trial's knobs set in the catalog it wrote."""
    org = into / "org"
    out = subprocess.run(
        ["deno", "run", "-A", str(REPO / "src" / "init.ts"), str(org), agent],
        capture_output=True,
        text=True,
    )
    if out.returncode != 0:
        raise RuntimeError(f"mu init failed: {out.stderr}")
    path = org / "config.jsonc"
    text = path.read_text()
    text = re.sub(r'"model": "[^"]*"', f'"model": "{model}"', text, count=1)
    text = re.sub(r'"maxTokens": \d+', f'"maxTokens": {MAX_TOKENS}', text, count=1)
    if effort:
        text = re.sub(r'"effort": null', f'"effort": "{effort}"', text, count=1)
    path.write_text(text)
    return org


class MuAgent(BaseInstalledAgent):
    @staticmethod
    @override
    def name() -> str:
        return "mu"

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        agent = await self.username(environment)
        model = self.model_name or "anthropic/claude-sonnet-5"
        if "/" in model:
            model = model.split("/", 1)[1]

        await environment.upload_file(host_deno(), DENO)
        await environment.upload_dir(REPO / "src", f"{MU}/src")
        await environment.upload_file(REPO / "deno.json", f"{MU}/deno.json")
        await environment.upload_file(REPO / "deno.lock", f"{MU}/deno.lock")
        with tempfile.TemporaryDirectory(prefix="mu-org-") as tmp:
            org = scaffold_org(Path(tmp), agent, model, self._get_env("MU_EFFORT"))
            await environment.upload_dir(org, ORG)
        # the egress proxy mints its CA with openssl; the org's shells and the model call
        # need nothing else from the image
        await self.exec_as_root(
            environment,
            command=(
                f"chmod 755 {DENO} && mkdir -p {DENO_DIR} && "
                f"(command -v openssl >/dev/null || "
                f"(apt-get update -qq && apt-get install -y -qq openssl) || "
                f"apk add --no-cache openssl) && "
                f"chown -R {shlex.quote(agent)} {INSTALL} && "
                f"cd {MU} && {DENO} cache src/cli.ts src/main.ts"
            ),
            env=SHELL_ENV,
        )

    async def username(self, environment: BaseEnvironment) -> str:
        """The agent is the container's user: the roster's one name and `mu cli`'s target."""
        who = await self.exec_as_agent(environment, command="id -un")
        name = (who.stdout or "").strip()
        if not re.fullmatch(r"[a-z][a-z0-9-]*", name):
            raise RuntimeError(f"container user {name!r} is not a mu agent name")
        return name

    @with_prompt_template
    async def run(
        self, instruction: str, environment: BaseEnvironment, context: AgentContext
    ) -> None:
        agent = await self.username(environment)
        env = {**SHELL_ENV}
        for key in ("ANTHROPIC_API_KEY",):
            value = self._get_env(key)
            if value:
                env[key] = value

        out = EnvironmentPaths.agent_dir
        cli = (
            f"{DENO} run -A {MU}/src/cli.ts --agent {shlex.quote(agent)} "
            f"--session task --timeout {TIMEOUT_S} "
            f"{shlex.quote(instruction)}"
        )
        await self.exec_as_agent(
            environment,
            command=(
                f"mkdir -p {out} && {cli} > {out}/mu-out.txt 2> {out}/mu-err.txt; "
                f"code=$?; cp -r {ORG}/data/log {out}/mu-log 2>/dev/null; exit $code"
            ),
            env=env,
        )
