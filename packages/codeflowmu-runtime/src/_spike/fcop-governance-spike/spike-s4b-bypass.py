"""S4b — try to bypass the interceptor.py mcp.types chain via direct submodule import.

If this works, CodeFlowMu can reuse `resolve_skill` + `emit_event` without
ever needing fastmcp + mcp + pydantic installed correctly.

If this also fails, the only fcop-mcp governance reuse path is via the
top-level governance/__init__.py, which transitively requires the FastMCP
stack to be stable.
"""
print("attempting: from fcop_mcp.governance.skill_resolver import resolve_skill")
from fcop_mcp.governance.skill_resolver import (
    SkillMeta,
    load_registry_yaml,
    resolve_skill,
)
print("attempting: from fcop_mcp.governance.events import emit_event")
from fcop_mcp.governance.events import emit_event

print("PASS: direct submodule import bypasses mcp.types / pydantic chain")
meta = resolve_skill("write_task")
print(f"meta: {meta}")
print(f"emit_event callable: {emit_event}")
print(f"load_registry_yaml callable: {load_registry_yaml}")
print(f"SkillMeta class: {SkillMeta}")
