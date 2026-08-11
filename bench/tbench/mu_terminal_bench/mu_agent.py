"""Harbor adapter for mu (BaseInstalledAgent).

mu ships as ONE compiled binary (deno task compile:task -> dist/mu-task): the harness,
the model transport, and the exec-plane binaries (multi-call `mu-task afs ...`) in a
single artifact -- install = upload + chmod. Task mode runs the instruction to
quiescence in the container's working directory and prints the closing message.
"""

import shlex
from pathlib import Path
from typing import override

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.trial.paths import EnvironmentPaths

BINARY = Path(__file__).resolve().parents[3] / "dist" / "mu-task"


class MuAgent(BaseInstalledAgent):
    @staticmethod
    @override
    def name() -> str:
        return "mu"

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        if not BINARY.exists():
            raise RuntimeError(
                f"{BINARY} missing -- compile it first: deno task compile:task"
            )
        await environment.upload_file(BINARY, "/installed-agent/mu-task")
        await self.exec_as_root(environment, command="chmod 755 /installed-agent/mu-task")

    @with_prompt_template
    async def run(
        self, instruction: str, environment: BaseEnvironment, context: AgentContext
    ) -> None:
        model = self.model_name or "anthropic/claude-sonnet-5"
        if "/" in model:
            model = model.split("/", 1)[1]

        env: dict[str, str] = {
            "MU_MODEL": model,
            "MU_TASK_TIMEOUT_S": self._get_env("MU_TASK_TIMEOUT_S") or "840",  # < harbor's 900s agent kill
        }
        for key in ("ANTHROPIC_API_KEY", "MU_EFFORT"):
            value = self._get_env(key)
            if value:
                env[key] = value

        out = EnvironmentPaths.agent_dir
        await self.exec_as_agent(
            environment,
            command=(
                f"mkdir -p {out} && /installed-agent/mu-task {shlex.quote(instruction)} "
                f"> {out}/mu-out.txt 2> {out}/mu-trace.log"
            ),
            env=env,
        )
