#!/usr/bin/env python3
"""Sync 007/014 panel helpers from _panel-inline.js into codeflowmu-desktop/panel/index.html."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
INLINE = ROOT / "codeflowmu-shell" / "scripts" / "_panel-inline.js"
DESKTOP = ROOT / "codeflowmu-desktop" / "panel" / "index.html"


def extract_block(src: str, start_marker: str, end_marker: str) -> str:
    i = src.index(start_marker)
    j = src.index(end_marker, i)
    return src[i:j]


def main() -> None:
    inline = INLINE.read_text(encoding="utf-8")
    html = DESKTOP.read_text(encoding="utf-8")

    helpers = extract_block(
        inline,
        "/** BFS: parent 链上的子任务并入 thread members",
        "function syncTaskThreadSelect(){",
    )

    old_pool = """function taskPageVisiblePool(){
  const pool=taskPageBasePool();
  if(taskArchiveTab==='all')return pool;
  const {visibleIds,threadMemberIds}=taskIdsMatchingRootArchiveTab(tasks);
  return pool.filter(f=>{
    const id=taskIdPrefix(f.filename);
    if(id&&threadMemberIds.has(id))return visibleIds.has(id);
    return taskMatchesArchiveTab(f);
  });
}

function syncTaskThreadSelect(){"""

    new_pool = helpers + "function syncTaskThreadSelect(){"
    if old_pool not in html:
        raise SystemExit("taskPageVisiblePool block not found in index.html")
    html = html.replace(old_pool, new_pool, 1)

    html = html.replace(
        "      const n=(m.members||[]).length;\n      return `<option value=\"${esc(m.id)}\">${esc(label)} (${n})</option>`;",
        "      const n=countAdminMainlinesForThread(m);\n      return `<option value=\"${esc(m.id)}\">${esc(label)} (${n})</option>`;",
        2,
    )

    html = html.replace(
        "$('tc-task',fmtK(pool.length));",
        "$('tc-task',fmtK(countAdminMainlinesInPool(pool)));",
        1,
    )

    html = html.replace(
        "  const taskCount=(chain.taskTree||[]).length;",
        "  const taskCount=countAdminMainlinesInReportChain(chain);",
        1,
    )

    old_bts = """function buildTaskBusThreads(taskList, ledgerRows){
  const ledgerSource=mergeLedgerRowsByRoot(ledgerRows||ledgerThreads||[]).filter(
    row=>Array.isArray(row.task_ids)&&row.task_ids.length
  );
  if(ledgerSource.length){
    const list=(taskList||[]).filter(t=>(t.filename||'').startsWith('TASK-'));
    const byPrefix={};
    list.forEach(t=>{
      const id=taskIdPrefix(t.filename);
      if(id)byPrefix[id]=t;
    });
    return ledgerSource.map(row=>{
      const rootId=taskIdPrefix(row.root_task_id||'');
      const members=[];
      (row.task_ids||[]).forEach(tid=>{
        const pid=String(tid).match(/^(TASK-\\d{8}-\\d{3})/);
        const id=pid?pid[1]:String(tid);
        const t=byPrefix[id];
        if(!t)return;
        if(id!==rootId&&isAdminMainlineTask(t.filename))return;
        members.push(t);
      });
      const root=(rootId&&byPrefix[rootId])||members.find(m=>taskIdPrefix(m.filename)===rootId)||members.find(m=>isAdminMainlineTask(m.filename))||members[0]||{"""

    new_bts_start = extract_block(
        inline,
        "function buildTaskBusThreads(taskList, ledgerRows){",
        "const root=(rootId&&byPrefix[rootId])||members.find(m=>taskIdPrefix(m.filename)===rootId)||members.find(m=>isAdminMainlineTask(m.filename))||members[0]||{",
    ) + "const root=(rootId&&byPrefix[rootId])||members.find(m=>taskIdPrefix(m.filename)===rootId)||members.find(m=>isAdminMainlineTask(m.filename))||members[0]||{"

    if old_bts not in html:
        raise SystemExit("buildTaskBusThreads block not found in index.html")
    html = html.replace(old_bts, new_bts_start, 1)

    old_stats = "$('tc-task',fmtK(tasks.length));$('tc-report',fmtK(reports.length));"
    new_stats = """if(curPage==='tasks'){
    $('tc-task',fmtK(countAdminMainlinesInPool(taskPageVisiblePool())));
  }else{
    $('tc-task',fmtK(tasks.length));
  }
  $('tc-report',fmtK(reports.length));"""
    if old_stats not in html:
        raise SystemExit("updateStats tc-task line not found in index.html")
    html = html.replace(old_stats, new_stats, 1)

    DESKTOP.write_text(html, encoding="utf-8")
    print("patched", DESKTOP)


if __name__ == "__main__":
    main()
