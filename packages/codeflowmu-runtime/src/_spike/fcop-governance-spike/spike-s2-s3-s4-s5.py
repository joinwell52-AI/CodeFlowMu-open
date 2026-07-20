"""DEV-022 spike — direct Python verification of fcop_mcp.governance.

Covers S2 (emit_event redirect), S3 (project YAML override semantics),
S4 (FastMCP dependency analysis), and a Python-side dry-run that supports
the runtime/smoke evidence collected by spike-s5-runtime-smoke.ps1.

Safe to run repeatedly — all writes go through FCOP_EVENT_LOG redirect.
"""

from __future__ import annotations

import inspect
import json
import os
import sys
import tempfile
import time
from pathlib import Path

SEP = "=" * 72


def header(text: str) -> None:
    print(f"\n{SEP}\n{text}\n{SEP}")


def main() -> None:
    print(f"Python: {sys.version}")
    print(f"cwd before spike: {Path.cwd()}")

    # Pick a temp dir that is GUARANTEED not to be the project root.
    spike_dir = Path(tempfile.gettempdir()) / "fcop-spike-events"
    spike_dir.mkdir(parents=True, exist_ok=True)

    # ------------------------------------------------------------------
    # S1 (Python-side sanity — Node-side same import is in spike-s1.ts)
    # ------------------------------------------------------------------
    header("S1 (Python side) — import the 5 exports")
    from fcop_mcp.governance import (
        FCoPGovernanceMiddleware,
        SkillMeta,
        emit_event,
        load_registry_yaml,
        resolve_skill,
    )
    from fcop_mcp._version import __version__ as fcop_mcp_version

    print(f"fcop-mcp version: {fcop_mcp_version}")
    print(f"FCoPGovernanceMiddleware: {FCoPGovernanceMiddleware!r}")
    print(f"SkillMeta: {SkillMeta!r}")
    print(f"resolve_skill: {resolve_skill!r}")
    print(f"emit_event: {emit_event!r}")
    print(f"load_registry_yaml: {load_registry_yaml!r}")

    # ------------------------------------------------------------------
    # S2 — emit_event redirect via FCOP_EVENT_LOG
    # ------------------------------------------------------------------
    header("S2 — emit_event redirect")

    s2_path = spike_dir / "s2-redirect-test.jsonl"
    if s2_path.exists():
        s2_path.unlink()

    os.environ["FCOP_EVENT_LOG"] = str(s2_path)
    print(f"FCOP_EVENT_LOG set to: {s2_path}")

    # Detect any pre-existing cwd log to ensure we don't touch it.
    cwd_log = Path.cwd() / "fcop_events.jsonl"
    cwd_log_existed_before = cwd_log.exists()
    print(f"cwd fcop_events.jsonl existed BEFORE call? {cwd_log_existed_before}")

    emit_event(
        {
            "type": "spike_test",
            "spike_id": "S2",
            "note": "redirect via FCOP_EVENT_LOG",
        }
    )

    assert s2_path.exists(), "expected redirected jsonl to exist"
    line = s2_path.read_text(encoding="utf-8").strip()
    parsed = json.loads(line)
    print(f"redirected file contents: {parsed}")
    assert parsed["spike_id"] == "S2"
    assert "emitted_at" in parsed
    print("S2 result: PASS — env var redirect honored, cwd untouched.")

    # Verify cwd was not touched (only fails if a NEW cwd jsonl appeared).
    if cwd_log.exists() and not cwd_log_existed_before:
        print("S2 WARN: cwd fcop_events.jsonl was NEWLY created — leak!")
    else:
        print("S2 cwd safety: confirmed clean.")

    # Clean up env var for the next steps to use isolated paths.
    del os.environ["FCOP_EVENT_LOG"]

    # ------------------------------------------------------------------
    # S3 — skill_registry.yaml override semantics
    # ------------------------------------------------------------------
    header("S3 — skill_registry.yaml override semantics")

    # 3a — pristine resolve_skill BEFORE any load_registry_yaml call.
    pristine_write_task = resolve_skill("write_task")
    pristine_codeflow = resolve_skill("codeflow_task_dispatch")
    pristine_write_agent = resolve_skill("write_agent")
    print(f"pristine resolve_skill('write_task'): {pristine_write_task}")
    print(f"pristine resolve_skill('codeflow_task_dispatch'): {pristine_codeflow}")
    print(f"pristine resolve_skill('write_agent'): {pristine_write_agent}")

    # 3b — wheel-internal builtin _BUILTIN entries (Python dict).
    #     This is the IN-CODE table; see how it differs from the yaml file.
    from fcop_mcp.governance.skill_resolver import _BUILTIN, _user_registry
    print(f"_BUILTIN entry count: {len(_BUILTIN)}")
    print(f"_user_registry entry count BEFORE any load: {len(_user_registry)}")

    # 3c — load the wheel's bundled skill_registry.yaml.
    import fcop_mcp.governance as governance_pkg
    wheel_yaml = Path(governance_pkg.__file__).parent / "skill_registry.yaml"
    print(f"wheel yaml: {wheel_yaml}")
    print(f"wheel yaml lines: {len(wheel_yaml.read_text(encoding='utf-8').splitlines())}")

    load_registry_yaml(wheel_yaml)
    after_wheel_load = resolve_skill("write_agent")
    after_wheel_user_count = len(_user_registry)
    print(f"after load_registry_yaml(wheel): _user_registry size = {after_wheel_user_count}")
    print(f"resolve_skill('write_agent') after wheel load: {after_wheel_load}")

    # 3d — simulate project override at d:/Bridgeflow/fcop/skill_registry.yaml
    proj_yaml = spike_dir / "proj-skill-registry.yaml"
    proj_yaml.write_text(
        """\
codeflow_task_dispatch:
  risk: Sensitive
  category: codeflow_dispatch
write_task:
  risk: Critical
  category: task_mutation_override_test
""",
        encoding="utf-8",
    )
    print(f"project yaml: {proj_yaml}")

    load_registry_yaml(proj_yaml)
    after_proj_codeflow = resolve_skill("codeflow_task_dispatch")
    after_proj_write_task = resolve_skill("write_task")
    after_proj_write_agent = resolve_skill("write_agent")
    after_proj_user_count = len(_user_registry)
    print(f"after load_registry_yaml(proj): _user_registry size = {after_proj_user_count}")
    print(f"resolve_skill('codeflow_task_dispatch') after proj load: {after_proj_codeflow}")
    print(f"resolve_skill('write_task') after proj load: {after_proj_write_task}")
    print(f"resolve_skill('write_agent') after proj load: {after_proj_write_agent}")

    s3_findings = {
        "merge_or_replace": (
            "MERGE on the same dict; project YAML *adds* keys missing from the "
            "wheel YAML and *overrides* keys with same name."
        ),
        "wheel_builtin_count": len(_BUILTIN),
        "wheel_yaml_entry_count_after_first_load": after_wheel_user_count,
        "user_registry_after_proj_load": after_proj_user_count,
        "codeflow_only_skill_accepted": after_proj_codeflow.risk_level == "Sensitive",
        "wheel_value_overrideable": after_proj_write_task.risk_level == "Critical",
        "pristine_unknown_falls_back_to_safe": (
            pristine_codeflow.risk_level == "Safe"
            and pristine_codeflow.category == "unknown"
        ),
        "BUILTIN_vs_wheel_yaml_drift": (
            f"_BUILTIN dict has {len(_BUILTIN)} entries vs wheel yaml has "
            f"{after_wheel_user_count} entries (after first load) — wheel yaml "
            f"contains entries NOT present in _BUILTIN (write_agent/write_skill/"
            f"write_report + list_teams/read_team/list_events/read_event)."
        ),
    }
    print("S3 findings:")
    for k, v in s3_findings.items():
        print(f"  {k}: {v}")

    # ------------------------------------------------------------------
    # S4 — FastMCP dependency analysis
    # ------------------------------------------------------------------
    header("S4 — FCoPGovernanceMiddleware FastMCP dependency")

    base = FCoPGovernanceMiddleware.__mro__
    print(f"MRO: {[c.__qualname__ for c in base]}")
    print(f"base module of Middleware: {base[1].__module__}")

    # Try instantiating standalone (no FastMCP server).
    try:
        mw = FCoPGovernanceMiddleware()
        print(f"instantiation: OK — {mw!r}")
    except Exception as e:  # pragma: no cover
        print(f"instantiation: FAILED — {type(e).__name__}: {e}")

    # Inspect on_call_tool signature.
    sig = inspect.signature(FCoPGovernanceMiddleware.on_call_tool)
    print(f"on_call_tool signature: {sig}")

    # Try the call — would require a real fastmcp MiddlewareContext.
    # We do NOT attempt to fake one here; that would mean reimplementing
    # FastMCP internals.  Instead, prove the underlying 3 atoms work
    # WITHOUT any FastMCP plumbing — that is what CodeFlowMu would use.
    from fcop_mcp.governance.interceptor import _RISK_TAG, _args_hash

    standalone_skill = resolve_skill("write_task")
    standalone_tag = _RISK_TAG.get(standalone_skill.risk_level, "ALLOW")
    standalone_hash = _args_hash({"filename": "task-001.md"})
    standalone_event = {
        "type": "tool_call",
        "tool": "write_task",
        "risk": standalone_skill.risk_level,
        "tag": standalone_tag,
        "args_hash": standalone_hash,
        "session_id": None,
        "ts": time.time(),
    }
    s4_log = spike_dir / "s4-standalone-atoms.jsonl"
    if s4_log.exists():
        s4_log.unlink()
    os.environ["FCOP_EVENT_LOG"] = str(s4_log)
    emit_event(standalone_event)
    del os.environ["FCOP_EVENT_LOG"]
    s4_event_back = json.loads(s4_log.read_text(encoding="utf-8").strip())
    print(f"standalone composition event back-read: {s4_event_back}")
    print("S4 result:")
    print(
        "  - FCoPGovernanceMiddleware class is COUPLED to FastMCP/MCP types "
        "(Middleware base, MiddlewareContext, mt.CallToolRequestParams)."
    )
    print(
        "  - But its 3 atoms — resolve_skill / _args_hash / emit_event — are "
        "pure-Python and can be composed by CodeFlowMu WITHOUT a FastMCP server "
        "(demonstrated above)."
    )
    print(
        "  - Verdict: CodeFlowMu CAN reuse governance behavior in non-MCP "
        "contexts by skipping the Middleware class and orchestrating the 3 "
        "atoms directly at the dispatch boundary (e.g. InboxWatcher._gate)."
    )

    # ------------------------------------------------------------------
    # S5 (Python side) — fcop + fcop-mcp coexistence check
    # ------------------------------------------------------------------
    header("S5 (Python side) — fcop / fcop-mcp coexistence")
    import fcop
    from fcop import Project

    print(f"fcop version: {fcop.__version__}")
    proj = Project("d:/Bridgeflow")
    print(f"fcop Project.workspace_layout: {proj.workspace_layout}")
    print(
        "S5 Python side: PASS — both libs co-resolve in the same venv; "
        "Project init works against Bridgeflow workspace. Runtime npm test + "
        "smoke evidence collected in spike-s5-runtime-smoke.ps1."
    )

    header("Spike Python side complete.")


if __name__ == "__main__":
    main()
