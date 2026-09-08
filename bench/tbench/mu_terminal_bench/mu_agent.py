"""Harbor adapter for mu (BaseInstalledAgent).

The container gets a Deno binary and this checkout's source, and an org scaffolded by
`mu init` inside the trial's mounted logs directory — the org's log IS the trial's record,
on the host from the first row, whatever ends the trial. The agent is the container's
user; the catalog carries the model and effort Harbor asks for. A trial is one `mu cli`
run in its own session: it stands in the task's working directory and `--dir` names the
org. The wall is the task's own (Harbor's agent timeout); the CLI sets none.

After the run the log is read on the host and written beside it as an ATIF trajectory:
one user step for the instruction, one agent step per turn (its text, its thinking, its
tool calls with their results, its spend), a system step per harness error.
"""

import json
import re
import shlex
import shutil
import sqlite3
import subprocess
import tempfile
from pathlib import Path
from typing import Any, override

from harbor.agents.installed.base import BaseInstalledAgent, with_prompt_template
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.trajectories.agent import Agent
from harbor.models.trajectories.final_metrics import FinalMetrics
from harbor.models.trajectories.metrics import Metrics
from harbor.models.trajectories.observation import Observation
from harbor.models.trajectories.observation_result import ObservationResult
from harbor.models.trajectories.step import Step
from harbor.models.trajectories.tool_call import ToolCall
from harbor.models.trajectories.trajectory import Trajectory
from harbor.models.trial.paths import EnvironmentPaths
from harbor.utils.trajectory_utils import format_trajectory_json

REPO = Path(__file__).resolve().parents[3]
INSTALL = "/installed-agent"
MU = f"{INSTALL}/mu"
DENO = f"{INSTALL}/deno"
DENO_DIR = f"{INSTALL}/deno-cache"
ORG = f"{EnvironmentPaths.agent_dir}/org"
SESSION = "task"

# The daemon an attach raises lingers this long past its last attachment before it closes
# the log; the run waits it out so the trajectory reads a checkpointed database.
LINGER_WAIT_S = 90

# What the harness process is handed. Agent shells never inherit it: bash issues user
# space an empty pocket plus the names it allows, so the key stays with the daemon.
HARNESS_ENV = {"DENO_DIR": DENO_DIR, "DENO_NO_UPDATE_CHECK": "1"}


def host_deno() -> Path:
    found = shutil.which("deno")
    if not found:
        raise RuntimeError("deno not on PATH — the container gets the host's binary")
    return Path(found).resolve()


def checkout_version() -> str:
    out = subprocess.run(
        ["git", "rev-parse", "--short", "HEAD"], cwd=REPO, capture_output=True, text=True
    )
    return out.stdout.strip() or "unknown"


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
    if effort:
        text = re.sub(r'"effort": null', f'"effort": "{effort}"', text, count=1)
    path.write_text(text)
    return org


class MuAgent(BaseInstalledAgent):
    @staticmethod
    @override
    def name() -> str:
        return "mu"

    def model(self) -> str:
        model = self.model_name or "anthropic/claude-sonnet-5"
        return model.split("/", 1)[1] if "/" in model else model

    async def username(self, environment: BaseEnvironment) -> str:
        """The agent is the container's user: the roster's one name and `mu cli`'s target."""
        who = await self.exec_as_agent(environment, command="id -un")
        name = (who.stdout or "").strip()
        if not re.fullmatch(r"[a-z][a-z0-9-]*", name):
            raise RuntimeError(f"container user {name!r} is not a mu agent name")
        return name

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        agent = await self.username(environment)
        await environment.upload_file(host_deno(), DENO)
        await environment.upload_dir(REPO / "src", f"{MU}/src")
        await environment.upload_file(REPO / "deno.json", f"{MU}/deno.json")
        await environment.upload_file(REPO / "deno.lock", f"{MU}/deno.lock")
        with tempfile.TemporaryDirectory(prefix="mu-org-") as tmp:
            org = scaffold_org(Path(tmp), agent, self.model(), self._get_env("MU_EFFORT"))
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
                f"chown -R {shlex.quote(agent)} {INSTALL} {ORG} && "
                f"cd {MU} && {DENO} cache src/cli.ts src/main.ts"
            ),
            env=HARNESS_ENV,
        )

    @with_prompt_template
    async def run(
        self, instruction: str, environment: BaseEnvironment, context: AgentContext
    ) -> None:
        agent = await self.username(environment)
        env = {**HARNESS_ENV}
        key = self._get_env("ANTHROPIC_API_KEY")
        if key:
            env["ANTHROPIC_API_KEY"] = key

        out = EnvironmentPaths.agent_dir
        cli = (
            f"{DENO} run -A {MU}/src/cli.ts --dir {ORG} --agent {shlex.quote(agent)} "
            f"--session {SESSION} {shlex.quote(instruction)}"
        )
        wal = f"{ORG}/data/log/log.db-wal"
        await self.exec_as_agent(
            environment,
            command=(
                f"{cli} > {out}/mu-out.txt 2> {out}/mu-err.txt; code=$?; "
                f"for i in $(seq {LINGER_WAIT_S}); do [ -e {wal} ] || break; sleep 1; done; "
                f"exit $code"
            ),
            env=env,
        )

    @override
    def populate_context_post_run(self, context: AgentContext) -> None:
        db = self.logs_dir / "org" / "data" / "log" / "log.db"
        if not db.exists():
            self.logger.warning(f"no org log at {db}")
            return
        trajectory = read_trajectory(db, self.model(), checkout_version())
        (self.logs_dir / "trajectory.json").write_text(
            format_trajectory_json(trajectory.to_json_dict())
        )
        totals = trajectory.final_metrics
        if totals is not None:
            context.n_input_tokens = totals.total_prompt_tokens
            context.n_output_tokens = totals.total_completion_tokens
            context.n_cache_tokens = totals.total_cached_tokens


def read_trajectory(db: Path, model: str, version: str) -> Trajectory:
    """The org's log as ATIF. Rows are grouped by the turn that wrote them; a turn is one
    model call, so it is one agent step, and the usage row stamped with its id is its
    spend. `immutable` reads a closed database without touching it."""
    conn = sqlite3.connect(f"file:{db}?immutable=1", uri=True)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT id, type, timestamp, agent_id, text, parts, payload FROM events "
        "WHERE session_id = ? ORDER BY id",
        (SESSION,),
    ).fetchall()
    usage = {
        r["turn_id"]: r
        for r in conn.execute(
            "SELECT turn_id, input_tokens, output_tokens, cache_read_tokens, "
            "cache_write_tokens FROM usage"
        )
    }
    conn.close()

    turns: dict[str, dict[str, Any]] = {}
    order: list[tuple[str, Any]] = []  # (kind, key) in log order

    def turn(tid: str, ts: str) -> dict[str, Any]:
        if tid not in turns:
            turns[tid] = {"ts": ts, "text": [], "thinking": [], "calls": [], "results": {}}
            order.append(("turn", tid))
        return turns[tid]

    for r in rows:
        payload = json.loads(r["payload"] or "{}")
        parts = json.loads(r["parts"] or "[]")
        tid = payload.get("turn_id")
        kind = r["type"]
        if kind == "message" and not tid:
            order.append(("user", r["text"] or text_of(parts)))
        elif kind == "message":
            turn(tid, r["timestamp"])["text"].append(r["text"] or text_of(parts))
        elif kind == "thinking":
            thought = data_of(parts).get("thinking")
            if thought:
                turn(tid, r["timestamp"])["thinking"].append(thought)
        elif kind == "tool_use":
            d = data_of(parts)
            turn(tid, r["timestamp"])["calls"].append(
                ToolCall(tool_call_id=r["id"], function_name=d["name"], arguments=d["input"])
            )
        elif kind == "tool_result":
            d = data_of(parts)
            output = d.get("output")
            content = output if isinstance(output, str) else json.dumps(output)
            if tid:
                turn(tid, r["timestamp"])["results"][payload.get("ref_id")] = content
        elif kind == "error":
            order.append(("error", (r["timestamp"], data_of(parts).get("error", ""))))

    steps: list[Step] = []
    prompt = completion = cached = 0
    for kind, key in order:
        if kind == "user":
            steps.append(Step(step_id=len(steps) + 1, source="user", message=key))
        elif kind == "error":
            ts, text = key
            steps.append(
                Step(step_id=len(steps) + 1, timestamp=ts, source="system", message=text)
            )
        else:
            t = turns[key]
            u = usage.get(key)
            metrics = None
            if u is not None:
                read = u["cache_read_tokens"] or 0
                p = u["input_tokens"] + read + (u["cache_write_tokens"] or 0)
                prompt, completion, cached = prompt + p, completion + u["output_tokens"], cached + read
                metrics = Metrics(prompt_tokens=p, completion_tokens=u["output_tokens"], cached_tokens=read)
            observation = None
            if t["calls"]:
                observation = Observation(
                    results=[
                        ObservationResult(
                            source_call_id=c.tool_call_id, content=t["results"].get(c.tool_call_id)
                        )
                        for c in t["calls"]
                    ]
                )
            steps.append(
                Step(
                    step_id=len(steps) + 1,
                    timestamp=t["ts"],
                    source="agent",
                    model_name=model,
                    message="\n".join(t["text"]),
                    reasoning_content="\n".join(t["thinking"]) or None,
                    tool_calls=t["calls"] or None,
                    observation=observation,
                    metrics=metrics,
                )
            )

    return Trajectory(
        schema_version="ATIF-v1.7",
        session_id=SESSION,
        agent=Agent(name="mu", version=version, model_name=model),
        steps=steps,
        final_metrics=FinalMetrics(
            total_prompt_tokens=prompt,
            total_completion_tokens=completion,
            total_cached_tokens=cached,
            total_steps=len(steps),
        ),
    )


def data_of(parts: list[dict[str, Any]]) -> dict[str, Any]:
    for p in parts:
        if p.get("type") == "data":
            return p.get("data") or {}
    return {}


def text_of(parts: list[dict[str, Any]]) -> str:
    return "\n".join(p.get("text", "") for p in parts if p.get("type") == "text")
