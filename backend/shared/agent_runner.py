"""Replaceable prompt -> text executor. Claude owns tools/model/permissions."""
from __future__ import annotations

import json
import logging
import math
import os
from pathlib import Path
import shutil
import signal
import subprocess
from tempfile import TemporaryDirectory
import time
from typing import Protocol

log = logging.getLogger("agent_runner")


class AgentRunner(Protocol):
    def run(self, prompt: str) -> str: ...


class AgentError(RuntimeError):
    """Safe diagnostic, never contains prompts, stderr or provider response bodies."""


def _executable() -> str | None:
    configured = os.environ.get("CLAUDE_CLI_PATH")
    if configured:
        return shutil.which(configured)
    found = shutil.which("claude")
    if found:
        return found
    # launchd does not inherit the interactive shell's PATH.
    for path in (Path.home() / ".local/bin/claude", Path("/opt/homebrew/bin/claude"), Path("/usr/local/bin/claude")):
        if path.is_file() and os.access(path, os.X_OK):
            return str(path)
    return None


def agent_available() -> bool:
    """Local readiness only; does not probe login, network or vision capabilities."""
    return (os.environ.get("LOG_ONLY", "0") != "1"
            and os.environ.get("AGENT_PROVIDER", "claude") == "claude"
            and _executable() is not None)


def _config_path(variable: str) -> str | None:
    value = os.environ.get(variable)
    if not value:
        return None
    path = Path(value).expanduser()
    try:
        if not path.is_absolute() or not isinstance(json.loads(path.read_text(encoding="utf-8")), dict):
            raise ValueError()
    except (OSError, ValueError):
        raise AgentError(f"Invalid {variable}: expected an absolute JSON object file") from None
    return str(path)


def parse_json_object(text: str) -> dict:
    raw = text.strip()
    if raw.startswith("```") and raw.endswith("```"):
        raw = "\n".join(raw.splitlines()[1:-1])
    try:
        result = json.loads(raw)
    except ValueError:
        raise AgentError("Agent returned invalid JSON") from None
    if not isinstance(result, dict):
        raise AgentError("Agent must return a JSON object")
    return result


def create_agent_runner(workdir: Path | None = None) -> AgentRunner:
    provider = os.environ.get("AGENT_PROVIDER", "claude")
    if provider != "claude":
        raise AgentError("Unsupported AGENT_PROVIDER")
    return ClaudeRunner(workdir)


class ClaudeRunner:
    def __init__(self, workdir: Path | None = None):
        self.workdir = workdir

    def run(self, prompt: str) -> str:
        if os.environ.get("LOG_ONLY", "0") == "1":
            raise AgentError("Agent disabled by LOG_ONLY")
        if not isinstance(prompt, str) or not prompt.strip():
            raise AgentError("Prompt must be non-empty text")
        if self.workdir is None:
            with TemporaryDirectory(prefix="visa-agent-") as directory:
                return self._run(prompt, Path(directory))
        return self._run(prompt, self.workdir)

    def _run(self, prompt: str, workdir: Path) -> str:
        executable = _executable()
        if not executable:
            raise AgentError("Claude CLI not found; configure CLAUDE_CLI_PATH")
        try:
            timeout = float(os.environ.get("AGENT_TIMEOUT_SECONDS", "300"))
            if not math.isfinite(timeout) or not 1 <= timeout <= 3600:
                raise ValueError()
        except ValueError:
            raise AgentError("AGENT_TIMEOUT_SECONDS must be within 1..3600") from None
        args = [executable, "--print", "--output-format", "json", "--no-session-persistence",
                "--setting-sources", "user"]
        # No permission bypass, command allowlist, SQL or tool policy in Python.
        for variable, flag in (("CLAUDE_SETTINGS_FILE", "--settings"), ("CLAUDE_MCP_CONFIG", "--mcp-config")):
            path = _config_path(variable)
            if path:
                args.extend([flag, path])
        if os.environ.get("AGENT_MODEL"):
            args.extend(["--model", os.environ["AGENT_MODEL"]])
        started = time.monotonic()
        status = "failed"
        process = None
        log.info("agent.started provider=claude")
        try:
            # shell=False; user text never enters a command line or shell expression.
            process = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                       stderr=subprocess.PIPE, cwd=workdir, start_new_session=True)
            try:
                stdout, _stderr = process.communicate(prompt.encode("utf-8"), timeout=timeout)
            except subprocess.TimeoutExpired:
                raise AgentError("Claude task timed out") from None
            if process.returncode != 0:
                raise AgentError("Claude process failed")
            if len(stdout) > 2_000_000:
                raise AgentError("Claude output exceeds limit")
            try:
                envelope = parse_json_object(stdout.decode("utf-8"))
            except UnicodeError:
                raise AgentError("Claude output is not UTF-8") from None
            if (envelope.get("type") != "result" or envelope.get("subtype") != "success"
                    or envelope.get("is_error") is not False):
                raise AgentError("Claude task did not complete successfully")
            if envelope.get("permission_denials"):
                raise AgentError("Claude tool permission denied; review Claude settings")
            result = envelope.get("result")
            if not isinstance(result, str) or not result.strip():
                raise AgentError("Claude returned no text")
            status = "completed"
            return result
        except OSError:
            raise AgentError("Could not start or communicate with Claude CLI") from None
        finally:
            if process is not None:
                # Kill the dedicated group, including ordinary child tool processes.
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                process.communicate()
            log.info("agent.finished provider=claude status=%s duration_ms=%.2f", status,
                     (time.monotonic() - started) * 1000)
