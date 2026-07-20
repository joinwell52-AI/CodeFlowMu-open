#!/usr/bin/env python3
"""Patch panel index.html — team dynamics lifecycle SoT filter."""
from pathlib import Path

PANEL = Path(__file__).resolve().parents[2] / "codeflowmu-desktop" / "panel" / "index.html"
text = PANEL.read_text(encoding="utf-8")

insert_after = """function dashboardTaskList(list){return (list||[]).filter(t=>!isEvalProtocolTask(t));}
"""

new_block = """function dashboardTaskList(list){return (list||[]).filter(t=>!isEvalProtocolTask(t));}
/** 团队动态 / Thread Bus：以 _lifecycle 当前桶为 SoT；archive 主线默认不展示 */
function threadShouldShowOnTeamDynamics(members){
  if(!members||!members.length)return false;
  const admin=members.find(m=>isAdminMainlineTask(m.filename||''));
  const root=admin||members[0];
  if(!root)return false;
  if(taskIsWorkflowSealed(root))return false;
  if(taskPhysicalScopeFromPath(root)==='archive')return false;
  const byId=buildTaskByIdMapForVisibility(members);
  const rootId=resolveAdminRootIdForTask(root,byId);
  if(rootId){
    const rootTask=byId[rootId];
    if(rootTask&&(taskPhysicalScopeFromPath(rootTask)==='archive'||taskIsWorkflowSealed(rootTask)))return false;
  }
  return members.some(m=>{
    if(!(m.filename||'').startsWith('TASK-'))return false;
    const s=taskEffectiveScopeKey(m);
    return s==='inbox'||s==='active'||s==='review'||s==='waiting_pm_consolidation';
  });
}
"""

if insert_after not in text:
    raise SystemExit("dashboardTaskList anchor not found")
text = text.replace(insert_after, new_block, 1)

text = text.replace(
    "  return raw.filter(th=>th.kind==='main').map(th=>{",
    "  return raw.filter(th=>th.kind==='main'&&threadShouldShowOnTeamDynamics(th.members)).map(th=>{",
)

text = text.replace(
    "function deriveNextOwner(members,badge,pendingPmReview,waitingPmConsolidation){\n  if(waitingPmConsolidation)return 'PM';",
    "function deriveNextOwner(members,badge,pendingPmReview,waitingPmConsolidation){\n  if(!threadShouldShowOnTeamDynamics(members))return '—';\n  if(waitingPmConsolidation)return 'PM';",
)

PANEL.write_text(text, encoding="utf-8")
print("Patched", PANEL)
