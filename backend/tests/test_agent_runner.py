"""Real subprocess tests with a synthetic CLI: no credentials, network or LLM."""
import json
from pathlib import Path
import sys
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient

from backend.app import app
from backend.shared.agent_runner import AgentError, ClaudeRunner, agent_available, create_agent_runner
from backend.modules.audit_rules.store import RuleStore
from backend.modules.material_audit.audit_agent import AuditAgent
from backend.modules.material_audit.rule_agent import LLMRuleAgent
from backend.tests.test_rule_pipeline import decision, publish, request, rule


FAKE_CLI = r'''
import json, os, pathlib, sys, time
prompt = sys.stdin.read()
mode = os.environ.get("FAKE_MODE", "success")
pathlib.Path(os.environ["FAKE_CAPTURE"]).write_text(json.dumps({
    "args": sys.argv[1:], "prompt": prompt, "cwd": os.getcwd()
}))
if mode == "timeout":
    time.sleep(15)
if mode == "exit":
    print("secret provider body", file=sys.stderr)
    sys.exit(2)
if mode == "invalid":
    print("secret invalid body")
    sys.exit(0)
result = "output text"
if mode == "audit":
    payload = json.loads(prompt[prompt.index('{'):])
    file = pathlib.Path(payload["materials"][0]["file"])
    assert file.read_bytes().startswith(b"\xff\xd8\xff")
    result = json.dumps({"status": "WARNING", "reason": "Synthetic agent result",
                         "checked_items": ["Synthetic file read"], "confidence": 0,
                         "evidence": []})
print(json.dumps({"type": "result", "subtype": "error_max_turns" if mode == "error" else "success",
                  "is_error": mode == "error", "result": "" if mode == "empty" else result,
                  "permission_denials": [{"tool_name": "Read"}] if mode == "denied" else []}))
'''


@pytest.fixture
def cli(tmp_path, monkeypatch):
    executable = tmp_path / "fake-claude"
    executable.write_text(f"#!{sys.executable}\n" + FAKE_CLI)
    executable.chmod(0o700)
    capture = tmp_path / "capture.json"
    for key in ("CLAUDE_SETTINGS_FILE", "CLAUDE_MCP_CONFIG", "AGENT_MODEL", "FAKE_MODE"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("LOG_ONLY", "0")
    monkeypatch.setenv("AGENT_PROVIDER", "claude")
    monkeypatch.setenv("AGENT_TIMEOUT_SECONDS", "5")
    monkeypatch.setenv("CLAUDE_CLI_PATH", str(executable))
    monkeypatch.setenv("FAKE_CAPTURE", str(capture))
    return capture


def test_prompt_text_contract_stdin_no_shell_and_cleanup(cli):
    prompt = "中文 $(touch DO_NOT_CREATE) `echo nope` ; ' quotes\nsecond line"
    assert create_agent_runner().run(prompt) == "output text"
    capture = json.loads(cli.read_text())
    assert capture["prompt"] == prompt and prompt not in capture["args"]
    assert "--no-session-persistence" in capture["args"]
    assert "--dangerously-skip-permissions" not in capture["args"]
    assert "--allowedTools" not in capture["args"]
    assert not Path(capture["cwd"]).exists()


def test_admin_configuration_passed_without_embedding_policy(cli, tmp_path, monkeypatch):
    settings = tmp_path / "settings.json"
    settings.write_text('{"permissions":{"allow":["Read"]}}')
    mcp = tmp_path / "mcp.json"
    mcp.write_text('{"mcpServers":{}}')
    monkeypatch.setenv("CLAUDE_SETTINGS_FILE", str(settings))
    monkeypatch.setenv("CLAUDE_MCP_CONFIG", str(mcp))
    monkeypatch.setenv("AGENT_MODEL", "test-model")
    ClaudeRunner().run("test")
    args = json.loads(cli.read_text())["args"]
    for flag, expected in (("--settings", str(settings)), ("--mcp-config", str(mcp)), ("--model", "test-model")):
        assert args[args.index(flag) + 1] == expected


@pytest.mark.parametrize("mode", ["exit", "invalid", "error", "empty", "denied", "timeout"])
def test_cli_failures_do_not_leak_output_and_cleanup(cli, monkeypatch, mode):
    monkeypatch.setenv("FAKE_MODE", mode)
    monkeypatch.setenv("AGENT_TIMEOUT_SECONDS", "1")
    with pytest.raises(AgentError) as error:
        ClaudeRunner().run("private prompt")
    assert "secret" not in str(error.value) and "private prompt" not in str(error.value)
    assert not Path(json.loads(cli.read_text())["cwd"]).exists()


def test_disabled_never_starts_cli(cli, monkeypatch):
    monkeypatch.setenv("LOG_ONLY", "1")
    assert not agent_available()
    with pytest.raises(AgentError, match="disabled"):
        ClaudeRunner().run("test")
    assert not cli.exists()


def test_missing_cli_and_unsupported_provider(cli, monkeypatch):
    monkeypatch.setenv("CLAUDE_CLI_PATH", "/nonexistent/claude")
    assert not agent_available()
    with pytest.raises(AgentError, match="not found"):
        ClaudeRunner().run("test")
    monkeypatch.setenv("AGENT_PROVIDER", "future-provider")
    with pytest.raises(AgentError, match="Unsupported"):
        create_agent_runner()
    assert not cli.exists()


@pytest.mark.parametrize("value", ["0", "nan", "inf", "oops", "3601"])
def test_invalid_timeout_rejected_before_execution(cli, monkeypatch, value):
    monkeypatch.setenv("AGENT_TIMEOUT_SECONDS", value)
    with pytest.raises(AgentError, match="TIMEOUT"):
        ClaudeRunner().run("test")
    assert not cli.exists()


def test_missing_config_rejected_before_execution(cli, monkeypatch):
    monkeypatch.setenv("CLAUDE_SETTINGS_FILE", "/missing/settings.json")
    with pytest.raises(AgentError, match="SETTINGS"):
        ClaudeRunner().run("test")
    assert not cli.exists()


def test_api_to_real_process_adapter(cli, monkeypatch, tmp_path):
    monkeypatch.setenv("FAKE_MODE", "audit")
    store = RuleStore(tmp_path / "rules", tmp_path / "checklists")
    publish(store, [rule()])
    monkeypatch.setattr("backend.modules.material_audit.runner.agent", AuditAgent(store))
    response = TestClient(app).post("/material-audit/run", json=request().model_dump())
    assert response.status_code == 200
    result = response.json()["results"][0]
    assert result["execution_status"] == "completed"
    assert result["details"] == "Synthetic agent result"
    assert not Path(json.loads(cli.read_text())["cwd"]).exists()


@pytest.mark.parametrize("response", ["invalid", "[]", '{"status":"PASS"}'])
def test_rule_adapter_bad_output_cleans_materials(response):
    directories = []
    def factory(workdir):
        directories.append(workdir)
        return SimpleNamespace(run=lambda prompt: response)
    with pytest.raises((AgentError, ValueError)):
        LLMRuleAgent(factory).evaluate(rule(), request().materials)
    assert not directories[0].exists()


def test_pdf_transfer_and_failed_runner_cleanup():
    import base64
    payload = request().model_dump()
    material = payload["materials"][0]
    raw = b"%PDF-synthetic"
    material.update(kind="pdf", media_type="application/pdf")
    material["sanitized_file"].update(media_type="application/pdf", size=len(raw),
                                    content="data:application/pdf;base64," + base64.b64encode(raw).decode())
    directories = []
    def factory(workdir):
        directories.append(workdir)
        assert (workdir / "input-001.pdf").read_bytes() == raw
        raise AgentError("synthetic failure")
    with pytest.raises(AgentError):
        LLMRuleAgent(factory).evaluate(rule(), request(**payload).materials)
    assert not directories[0].exists()


def test_invalid_signature_never_calls_agent():
    import base64
    materials = request().materials
    materials[0].sanitized_file.content = "data:image/jpeg;base64," + base64.b64encode(b"x" * materials[0].sanitized_file.size).decode()
    factory = Mock()
    with pytest.raises(ValueError, match="signature"):
        LLMRuleAgent(factory).evaluate(rule(), materials)
    factory.assert_not_called()
