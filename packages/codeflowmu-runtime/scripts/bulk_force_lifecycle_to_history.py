#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Force-move all active FCoP coordination files into fcop/history/ (ADMIN bulk cleanup).

Unlike panel archiveToHistory, this script:
- includes today's files
- moves TASK from archive + done (no pair requirement to move task)
- clears fcop/reports/ entirely (orphans → _bulk-cleanup-*/reports/)
- moves fcop/issues/, fcop/reviews/, fcop/alerts/, fcop/attachments/ into history buckets
- archives fcop/ledger/journal.jsonl snapshot and truncates active journal
"""
from __future__ import annotations

import json
import re
import shutil
import sys
from datetime import date
from pathlib import Path

TASK_SEQ_RE = re.compile(r"TASK-(\d{8})-(\d{3})", re.I)
REPORT_SEQ_RE = re.compile(r"REPORT-(\d{8})-(\d{3})", re.I)
TASK_ID_LONG_RE = re.compile(
    r"TASK-\d{8}-\d{3,}-[A-Za-z0-9_-]+-to-[A-Za-z0-9_.-]+", re.I
)
TASK_ID_SHORT_RE = re.compile(r"TASK-\d{8}-\d{3}", re.I)
ROUTE_RE = re.compile(
    r"^(?:TASK|REPORT)-\d{8}-\d{3}-([A-Za-z0-9_-]+)-to-([A-Za-z0-9_.-]+)",
    re.I,
)


def parse_fm(raw: str) -> dict[str, str]:
    fm: dict[str, str] = {}
    m = re.match(r"^---\r?\n([\s\S]*?)\r?\n---", raw)
    if not m:
        return fm
    for line in m.group(1).split("\n"):
        kv = re.match(r"^(\w[\w_-]*):\s*(.+)", line)
        if kv:
            fm[kv.group(1)] = kv.group(2).strip()
    return fm


def linked_task_ids(raw: str) -> list[str]:
    ids: set[str] = set()
    fm_block = re.match(r"^---\r?\n([\s\S]*?)\r?\n---", raw)
    fm_text = fm_block.group(1) if fm_block else ""
    fm_close = raw.find("\n---", 3)
    body = raw[fm_close + 4 :] if fm_close >= 0 else raw
    fm = parse_fm(raw)

    def scan(text: str) -> None:
        ids.update(m.group(0) for m in TASK_ID_LONG_RE.finditer(text))
        ids.update(m.group(0) for m in TASK_ID_SHORT_RE.finditer(text))

    scan(fm_text)
    scan(body)
    for key in ("task_id", "parent", "references", "subject_id"):
        val = fm.get(key, "")
        if val.startswith("[") and val.endswith("]"):
            for part in re.findall(r"TASK-[^\],\s]+", val):
                scan(part)
        elif val:
            scan(val)
    return sorted(ids)


def task_route(fn: str) -> tuple[str, str] | None:
    m = ROUTE_RE.match(fn)
    if not m:
        return None
    return m.group(1).upper(), m.group(2).split(".")[0].upper()


def report_pairs_with_task(task_fn: str, report_fn: str, report_raw: str) -> bool:
    task_key = re.sub(r"\.md$", "", task_fn, flags=re.I)
    task_id_m = re.match(r"^(TASK-\d{8}-\d{3})", task_key, re.I)
    task_id = task_id_m.group(1) if task_id_m else ""
    linked = linked_task_ids(report_raw)
    if task_key and task_key in linked:
        return True
    if not task_id or task_id not in linked:
        return False

    route = task_route(task_fn)
    rr = task_route(report_fn)

    if re.search(r"-ADMIN-to-PM", task_fn, re.I):
        return bool(re.search(r"-PM-to-ADMIN", report_fn, re.I))
    if re.search(r"-PM-to-(DEV|OPS|QA)", task_fn, re.I):
        if not re.search(r"-(DEV|OPS|QA)-to-PM", report_fn, re.I):
            return False
        if route and rr:
            return rr[0] == route[1]
        return True
    if route and rr:
        return rr[0] == route[1]
    return True


def ymd_to_bucket(ymd: str) -> str:
    return f"{ymd[:4]}-{ymd[4:6]}-{ymd[6:8]}"


def collect_reports(reports_dir: Path, lifecycle: Path) -> dict[str, Path]:
    """basename -> path (prefer reports_dir over archive)."""
    out: dict[str, Path] = {}
    for stage in ("archive", "done", "review"):
        d = lifecycle / stage
        if not d.is_dir():
            continue
        for p in d.glob("REPORT-*.md"):
            out.setdefault(p.name, p)
    if reports_dir.is_dir():
        for p in reports_dir.glob("REPORT-*.md"):
            out[p.name] = p
    return out


def safe_move(src: Path, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists():
        dest.unlink()
    shutil.move(str(src), str(dest))


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: bulk_force_lifecycle_to_history.py <projectRoot>", file=sys.stderr)
        return 2

    root = Path(sys.argv[1]).resolve()
    fcop = root / "fcop"
    lifecycle = fcop / "_lifecycle"
    reports_dir = fcop / "reports"
    history_root = fcop / "history"
    today_bucket = date.today().isoformat()
    orphan_dir = history_root / today_bucket / "_bulk-cleanup-panel" / "reports"

    reports_by_name = collect_reports(reports_dir, lifecycle)
    used_reports: set[str] = set()
    moved_tasks: list[str] = []
    moved_reports: list[str] = []
    moved_orphans: list[str] = []

    task_sources: list[Path] = []
    for stage in ("archive", "done"):
        d = lifecycle / stage
        if d.is_dir():
            task_sources.extend(sorted(d.glob("TASK-*.md")))

    for tp in task_sources:
        name = tp.name
        m = TASK_SEQ_RE.search(name)
        if not m:
            continue
        task_ymd = m.group(1)
        stem = name[:-3] if name.endswith(".md") else name
        shard_dir = history_root / ymd_to_bucket(task_ymd) / stem

        paired: list[Path] = []
        for rname, rp in list(reports_by_name.items()):
            if rname in used_reports:
                continue
            try:
                raw = rp.read_text(encoding="utf-8")
            except OSError:
                continue
            if report_pairs_with_task(name, rname, raw):
                paired.append(rp)

        safe_move(tp, shard_dir / name)
        moved_tasks.append(name)
        for rp in paired:
            if not rp.exists():
                continue
            rname = rp.name
            safe_move(rp, shard_dir / rname)
            moved_reports.append(rname)
            used_reports.add(rname)
            reports_by_name.pop(rname, None)

    # Remaining reports → orphan bucket
    remaining = list(reports_by_name.values())
    for rp in remaining:
        if not rp.exists():
            continue
        rname = rp.name
        safe_move(rp, orphan_dir / rname)
        moved_orphans.append(rname)

    # Any REPORT left in lifecycle stages
    for stage in ("archive", "done", "review"):
        d = lifecycle / stage
        if not d.is_dir():
            continue
        for rp in list(d.glob("REPORT-*.md")):
            rname = rp.name
            safe_move(rp, orphan_dir / rname)
            moved_orphans.append(rname)

    bulk_root = history_root / today_bucket / "_bulk-cleanup-panel"
    moved_issues: list[str] = []
    moved_reviews: list[str] = []
    moved_alerts: list[str] = []
    moved_attachments: list[str] = []
    archived_journal: str | None = None

    issues_dir = fcop / "issues"
    if issues_dir.is_dir():
        issue_dest = bulk_root / "issues"
        for p in sorted(issues_dir.glob("*.md")):
            safe_move(p, issue_dest / p.name)
            moved_issues.append(p.name)

    reviews_dir = fcop / "reviews"
    if reviews_dir.is_dir():
        review_dest = bulk_root / "reviews"
        for p in sorted(reviews_dir.glob("*.md")):
            safe_move(p, review_dest / p.name)
            moved_reviews.append(p.name)

    alerts_dir = fcop / "alerts"
    if alerts_dir.is_dir():
        alert_dest = bulk_root / "alerts"
        for p in sorted(alerts_dir.glob("*.md")):
            safe_move(p, alert_dest / p.name)
            moved_alerts.append(p.name)

    attachments_dir = fcop / "attachments"
    if attachments_dir.is_dir():
        attach_dest = bulk_root / "attachments"
        for p in sorted(attachments_dir.rglob("*")):
            if not p.is_file():
                continue
            rel = p.relative_to(attachments_dir)
            safe_move(p, attach_dest / rel)
            moved_attachments.append(str(rel).replace("\\", "/"))
        # remove empty date shards left under attachments/
        for d in sorted(attachments_dir.iterdir(), reverse=True):
            if d.is_dir():
                try:
                    d.rmdir()
                except OSError:
                    pass

    index_archive = fcop / "shared" / "INDEX-three-line-freeze-archive-20260607.md"
    moved_index: str | None = None
    if index_archive.is_file():
        idx_dest = history_root / "2026-06-07" / "three-line-freeze" / index_archive.name
        safe_move(index_archive, idx_dest)
        moved_index = index_archive.name

    journal_path = fcop / "ledger" / "journal.jsonl"
    if journal_path.is_file() and journal_path.stat().st_size > 0:
        journal_dest = bulk_root / "journal" / f"journal-{today_bucket}.jsonl"
        journal_dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(str(journal_path), str(journal_dest))
        journal_path.write_text("", encoding="utf-8")
        archived_journal = str(journal_dest.relative_to(root)).replace("\\", "/")

    # Erroneous nested fcop/fcop/ledger/views (stale duplicate)
    nested_views = fcop / "fcop" / "ledger" / "views"
    removed_nested: list[str] = []
    if nested_views.is_dir():
        for p in sorted(nested_views.glob("*.md")):
            p.unlink()
            removed_nested.append(p.name)
        for d in [nested_views, nested_views.parent, nested_views.parent.parent]:
            if d.is_dir():
                try:
                    d.rmdir()
                except OSError:
                    pass

    summary = {
        "moved_tasks": moved_tasks,
        "moved_reports_paired": moved_reports,
        "moved_reports_orphan": moved_orphans,
        "orphan_dir": str(orphan_dir.relative_to(root)).replace("\\", "/"),
        "moved_issues": moved_issues,
        "moved_reviews": moved_reviews,
        "moved_alerts": moved_alerts,
        "moved_attachments": moved_attachments,
        "moved_index": moved_index,
        "archived_journal": archived_journal,
        "removed_nested_views": removed_nested,
        "bulk_root": str(bulk_root.relative_to(root)).replace("\\", "/"),
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
