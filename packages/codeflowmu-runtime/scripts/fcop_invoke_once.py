# -*- coding: utf-8 -*-
"""One-shot fcop-mcp tool invocation (no stdio JSON-RPC server).

Used on Windows where long-lived ``python -m fcop_mcp`` stdio pipes deadlock.
Stdout is UTF-8 text (tool return string or JSON error object).
"""
from __future__ import annotations

import glob
import hashlib
import json
import os
import re
import sys

# Tools that route by envelope filename (not task_id alone).
_FILENAME_TOOLS = frozenset(
    {
        "read_task",
        "read_report",
        "inspect_task",
        "archive_task",
        "claim",
        "submit",
        "finish",
        "approve",
        "reject",
    }
)

_LIFECYCLE_STAGES = ("inbox", "active", "review", "done", "archive")

_LIFECYCLE_MUTATION_TOOLS = frozenset(
    {
        "claim",
        "claim_task",
        "submit",
        "submit_task",
        "submit_review",
        "finish",
        "finish_task",
        "approve",
        "approve_task",
        "approve_review",
        "reject",
        "reject_task",
        "reject_review",
        "archive_task",
    }
)

# Must route through LifecycleKernel — never fcop_mcp raw MV (ADR-0002).
_KERNEL_EXCLUSIVE_TOOLS = frozenset(
    {
        "submit",
        "submit_task",
        "submit_review",
        "approve",
        "approve_task",
        "approve_review",
        "reject",
        "reject_task",
        "reject_review",
        "archive_task",
        "finish",
        "finish_task",
    }
)

_TASK_PREFIX_RE = re.compile(r"^TASK-\d{8}-\d{3,}", re.IGNORECASE)
_PARENT_BODY_PATTERNS = (
    re.compile(r"父任务引用[：:]\s*(?:\*{0,2}\s*)?(TASK-\d{8}-\d{3,})", re.I),
    re.compile(r"parent\s*task\s*[：:]\s*(?:\*{0,2}\s*)?(TASK-\d{8}-\d{3,})", re.I),
    re.compile(r"\breferences?\s*[：:=]\s*(TASK-\d{8}-\d{3,})", re.I),
    re.compile(r"\bparent\s*[：:=]\s*(TASK-\d{8}-\d{3,})", re.I),
)
_ROOT_BODY_PATTERNS = (
    re.compile(
        r"主任务[：:]\s*`?(TASK-\d{8}-\d{3,}(?:-[A-Za-z0-9_-]+-to-[A-Za-z0-9_.-]+)?)`?",
        re.I,
    ),
    re.compile(
        r"(?:root|main)\s*task\s*[：:]\s*`?"
        r"(TASK-\d{8}-\d{3,}(?:-[A-Za-z0-9_-]+-to-[A-Za-z0-9_.-]+)?)`?",
        re.I,
    ),
)
_TASK_ID_LONG_RE = re.compile(
    r"TASK-\d{8}-\d{3,}-[A-Za-z0-9_-]+-to-[A-Za-z0-9_.-]+", re.I
)
_THREAD_KEY_BODY_RE = re.compile(
    r"thread_key\s*[：:]\s*`?([a-zA-Z0-9][a-zA-Z0-9_.-]*)`?", re.I
)
_REPORT_PREFIX_RE = re.compile(r"^REPORT-\d{8}-\d{3,}", re.IGNORECASE)


def _find_fcop_sdk_repo_root(start_dir: str) -> str | None:
    """Walk upward from start_dir to find repo root containing fcop_sdk/."""
    cur = os.path.abspath(start_dir)
    for _ in range(16):
        marker = os.path.join(cur, "fcop_sdk", "ledger_bridge.py")
        if os.path.isfile(marker):
            return cur
        parent = os.path.dirname(cur)
        if parent == cur:
            break
        cur = parent
    return None


def _prepend_pythonpath(segment: str) -> None:
    sep = os.pathsep
    cur = os.environ.get("PYTHONPATH", "").strip()
    if segment not in (cur.split(sep) if cur else []):
        os.environ["PYTHONPATH"] = f"{segment}{sep}{cur}" if cur else segment


def _ensure_fcop_sdk_importable(project_root: str) -> None:
    """Ensure fcop_sdk is importable (repo root on sys.path + PYTHONPATH)."""
    repo_root = _find_fcop_sdk_repo_root(project_root)
    if not repo_root:
        return
    if repo_root not in sys.path:
        sys.path.insert(0, repo_root)
    _prepend_pythonpath(repo_root)


def _parse_legacy_cli_args(argv: list[str]) -> dict:
    """Accept legacy argv: <project_root> <tool> key=value ..."""
    tool = argv[2] if len(argv) > 2 else ""
    args: dict[str, object] = {}
    for part in argv[3:]:
        if "=" not in part:
            continue
        key, value = part.split("=", 1)
        key = key.strip()
        value = value.strip()
        if not key:
            continue
        if value.lower() == "true":
            args[key] = True
        elif value.lower() == "false":
            args[key] = False
        elif value.lower() in ("null", "none"):
            args[key] = None
        else:
            args[key] = value
    return {"tool": tool, "arguments": args}


def _parse_payload(argv: list[str]) -> dict:
    """Parse JSON payload, with compatibility for legacy tool/key=value argv."""
    payload_arg = argv[2]
    payload_path = payload_arg[1:] if payload_arg.startswith("@") else payload_arg
    if os.path.isfile(payload_path):
        try:
            with open(payload_path, "r", encoding="utf-8-sig") as fh:
                payload_arg = fh.read()
        except OSError:
            return _parse_legacy_cli_args(argv)
    try:
        payload = json.loads(payload_arg)
    except json.JSONDecodeError:
        return _parse_legacy_cli_args(argv)
    if isinstance(payload, dict):
        return payload
    return {"tool": "", "arguments": {}}


def _strip_markdown_frontmatter(body: str) -> tuple[str, bool]:
    """If body starts with YAML frontmatter, return markdown body only."""
    text = body if body is not None else ""
    if not text.lstrip().startswith("---"):
        return text, False
    stripped = text.lstrip()
    end = stripped.find("\n---", 3)
    if end < 0:
        return text, False
    rest = stripped[end + 4 :]
    if rest.startswith("\r\n"):
        rest = rest[2:]
    elif rest.startswith("\n"):
        rest = rest[1:]
    return rest, True


def _ledger_rebuild(project_root: str) -> None:
    try:
        from fcop_sdk.ledger_bridge import rebuild_ledger

        rebuild_ledger(project_root)
    except Exception as exc:
        print(f"[ledger] rebuild warning: {exc}", file=sys.stderr)


def _handle_list_tasks(project_root: str, args: dict) -> str:
    from fcop_sdk.ledger_bridge import (
        format_list_tasks_output,
        list_tasks_from_ledger,
        rebuild_ledger,
    )

    rebuild_ledger(project_root)
    recipient = _pick_alias(args, "recipient", "role")
    tasks = list_tasks_from_ledger(project_root, recipient)
    return format_list_tasks_output(tasks)


def _resolve_report_path(project_root: str, args: dict, out: object) -> str | None:
    """Best-effort path to REPORT file after write_report."""
    for key in ("filename", "report_id", "reportId", "path"):
        val = args.get(key)
        if isinstance(val, str) and val.strip():
            base = os.path.basename(_ensure_md(val.strip()))
            for sub in ("reports", "_lifecycle/review", "_lifecycle/done"):
                cand = os.path.join(project_root, "fcop", sub.replace("/", os.sep), base)
                if os.path.isfile(cand):
                    return cand

    task_id = _pick_alias(args, "task_id", "taskId")
    if task_id:
        prefix = task_id.replace(".md", "")
        reports_dir = os.path.join(project_root, "fcop", "reports")
        if os.path.isdir(reports_dir):
            hits = sorted(
                glob.glob(os.path.join(reports_dir, f"REPORT-*{prefix}*.md")),
                key=os.path.getmtime,
                reverse=True,
            )
            if hits:
                return hits[0]

    if isinstance(out, str):
        m = re.search(r"(REPORT-\d{8}-\d{3,}[^\s`\"']*\.md)", out)
        if m:
            base = m.group(1)
            cand = os.path.join(project_root, "fcop", "reports", base)
            if os.path.isfile(cand):
                return cand

    reporter = _pick_alias(args, "reporter", "sender")
    if reporter and str(reporter).upper() == "PM":
        reports_dir = os.path.join(project_root, "fcop", "reports")
        if os.path.isdir(reports_dir):
            hits = sorted(
                glob.glob(os.path.join(reports_dir, "REPORT-*-PM-to-ADMIN*.md")),
                key=os.path.getmtime,
                reverse=True,
            )
            if hits:
                return hits[0]
    return None


def _resolve_task_path(project_root: str, args: dict, out: object) -> str | None:
    """Best-effort path to TASK file after write_task."""
    for key in ("filename", "task_id", "taskId", "path"):
        val = args.get(key)
        if isinstance(val, str) and val.strip():
            base = os.path.basename(_ensure_md(val.strip()))
            for stage in _LIFECYCLE_STAGES:
                cand = os.path.join(
                    project_root, "fcop", "_lifecycle", stage, base
                )
                if os.path.isfile(cand):
                    return cand
            legacy = os.path.join(project_root, "fcop", "tasks", base)
            if os.path.isfile(legacy):
                return legacy

    if isinstance(out, str):
        m = re.search(r"(TASK-\d{8}-\d{3,}[^\s`\"']*\.md)", out)
        if m:
            base = m.group(1)
            for stage in _LIFECYCLE_STAGES:
                cand = os.path.join(
                    project_root, "fcop", "_lifecycle", stage, base
                )
                if os.path.isfile(cand):
                    return cand
            legacy = os.path.join(project_root, "fcop", "tasks", base)
            if os.path.isfile(legacy):
                return legacy
    return None


def _stamp_envelope_timestamps(path: str | None) -> None:
    if not path:
        return
    try:
        from fcop_sdk.envelope_timestamps import stamp_envelope_timestamps

        stamp_envelope_timestamps(path)
    except Exception as exc:
        print(f"[timestamps] stamp warning: {exc}", file=sys.stderr)


def _enrich_report_frontmatter_from_args(
    project_root: str, report_path: str | None, args: dict
) -> None:
    """Keep REPORT frontmatter linked to the task passed to write_report."""
    if not report_path:
        return
    try:
        from fcop_sdk.protocol import read_fcop_file, write_fcop_file
    except Exception:
        return

    try:
        fm, body = read_fcop_file(report_path)
    except Exception:
        return

    changed = False
    basename = os.path.basename(report_path)
    report_id = basename[:-3] if basename.lower().endswith(".md") else basename

    def set_if_missing(key: str, value: object) -> None:
        nonlocal changed
        if value in (None, ""):
            return
        if fm.get(key) in (None, ""):
            fm[key] = value
            changed = True

    raw_task_id = str(
        fm.get("task_id")
        or fm.get("source_task_id")
        or _pick_alias(args, "task_id", "taskId", "filename", "id")
        or ""
    ).strip()
    task_id = ""
    task_fields: dict[str, str] = {}
    if raw_task_id:
        task_id = _task_id_token_for_mcp(
            _resolve_write_report_task_id(project_root, raw_task_id)
        )
        task_path = _resolve_write_report_task_id(project_root, task_id)
        if os.path.isfile(task_path):
            task_fields = _read_file_frontmatter_fields(task_path)

    set_if_missing("protocol", "fcop")
    set_if_missing("version", 1)
    set_if_missing("kind", "report")
    set_if_missing("report_id", report_id)
    set_if_missing("sender", _pick_alias(args, "reporter", "sender"))
    set_if_missing("reporter", fm.get("sender") or _pick_alias(args, "reporter", "sender"))
    set_if_missing("recipient", _pick_alias(args, "recipient"))
    set_if_missing("status", _normalize_report_status(_pick_alias(args, "status")))
    set_if_missing("session_id", _pick_alias(args, "session_id", "sessionId"))
    set_if_missing("run_id", _pick_alias(args, "run_id", "runId"))
    evidence_refs = args.get("evidence_refs") or args.get("evidenceRefs")
    if evidence_refs and not fm.get("evidence_refs"):
        fm["evidence_refs"] = (
            [str(value) for value in evidence_refs if value]
            if isinstance(evidence_refs, list)
            else [str(evidence_refs)]
        )
        changed = True
    if task_id:
        if fm.get("task_id") != task_id:
            fm["task_id"] = task_id
            changed = True
        set_if_missing("source_task_id", task_id)
        if not fm.get("thread_key") and task_fields.get("thread_key"):
            fm["thread_key"] = task_fields["thread_key"]
            changed = True
        if not fm.get("references"):
            refs = [task_id]
            parent = task_fields.get("parent", "").strip()
            if parent and parent not in refs:
                refs.append(parent)
            fm["references"] = refs
            changed = True

    if changed:
        write_fcop_file(report_path, fm, body)


def _post_write_report(project_root: str, args: dict, out: object) -> None:
    try:
        from fcop_sdk.ledger_bridge import resolve_report_after_write

        report_path = _resolve_report_path(project_root, args, out)
        _stamp_envelope_timestamps(report_path)
        if report_path:
            _enrich_report_frontmatter_from_args(project_root, report_path, args)
            _enrich_pm_admin_report_frontmatter(project_root, report_path, args)
            resolve_report_after_write(project_root, report_path)
        else:
            _ledger_rebuild(project_root)
    except Exception as exc:
        print(f"[ledger] post-write_report hook warning: {exc}", file=sys.stderr)


def _post_write_task(project_root: str, args: dict, out: object) -> None:
    try:
        task_path = _resolve_task_path(project_root, args, out)
        if task_path:
            try:
                from fcop_sdk.protocol import read_fcop_file, write_fcop_file

                fm, body = read_fcop_file(task_path)
                filename = os.path.basename(task_path)
                task_match = re.search(r"TASK-\d{8}-\d{3,}", filename, re.IGNORECASE)
                if task_match:
                    fm["task_id"] = task_match.group(0).upper()
                for key in ("thread_key", "parent", "references", "depends_on"):
                    value = args.get(key)
                    if value not in (None, "", []):
                        fm[key] = value
                write_fcop_file(task_path, fm, body)
            except Exception as exc:
                print(f"[fcop] task enrichment warning: {exc}", file=sys.stderr)
        _stamp_envelope_timestamps(task_path)
        _ledger_rebuild(project_root)
    except Exception as exc:
        print(f"[ledger] post-write_task hook warning: {exc}", file=sys.stderr)


def _fcop_root() -> str:
    return os.path.join(os.getcwd(), "fcop")


def _lifecycle_dirs() -> list[str]:
    root = _fcop_root()
    dirs: list[str] = []
    for stage in _LIFECYCLE_STAGES:
        p = os.path.join(root, "_lifecycle", stage)
        if os.path.isdir(p):
            dirs.append(p)
    # v2 legacy buckets (detect-and-warn projects)
    for bucket in ("tasks", "reports"):
        p = os.path.join(root, bucket)
        if os.path.isdir(p):
            dirs.append(p)
    return dirs


def _ensure_md(name: str) -> str:
    base = (name or "").strip()
    if not base:
        return base
    if not base.lower().endswith(".md"):
        return base + ".md"
    return base


def _has_valid_fcop_frontmatter(path: str) -> bool:
    try:
        with open(path, encoding="utf-8") as f:
            raw = f.read(8192)
    except OSError:
        return False
    if not raw.startswith("---"):
        return False
    end = raw.find("\n---", 3)
    if end < 0:
        return False
    fm = raw[3:end]
    return bool(re.search(r"^protocol:\s*(fcop|agent_bridge)\s*$", fm, re.M))


def _quarantine_corrupt_inbox_stub(project_root: str, token: str) -> bool:
    """Move invalid inbox duplicate when a valid copy exists elsewhere.

    fcop ``_resolve_task_file`` strips paths to basename and searches inbox
    before active — a corrupt inbox stub after rename+append blocks write_report.
    """
    basename = os.path.basename(_ensure_md(token))
    if not basename:
        return False

    fcop_root = os.path.join(project_root, "fcop")
    inbox_path = os.path.join(fcop_root, "_lifecycle", "inbox", basename)
    if not os.path.isfile(inbox_path) or _has_valid_fcop_frontmatter(inbox_path):
        return False

    valid_stages = ("active", "review", "done", "archive")
    has_valid = any(
        os.path.isfile(os.path.join(fcop_root, "_lifecycle", stage, basename))
        and _has_valid_fcop_frontmatter(
            os.path.join(fcop_root, "_lifecycle", stage, basename)
        )
        for stage in valid_stages
    )
    if not has_valid:
        return False

    import shutil
    from datetime import datetime, timezone

    qdir = os.path.join(project_root, ".codeflowmu", "stub-quarantine")
    os.makedirs(qdir, exist_ok=True)
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    stem = basename[:-3] if basename.lower().endswith(".md") else basename
    dest = os.path.join(qdir, f"{stem}.{ts}.md")
    shutil.move(inbox_path, dest)
    print(
        f"[fcop] quarantined corrupt inbox stub: {inbox_path} -> {dest}",
        file=sys.stderr,
    )
    return True


def _stage_rank(path: str) -> int:
    norm = path.replace("\\", "/")
    order = ("active", "review", "done", "inbox", "archive")
    for i, stage in enumerate(order):
        if f"/_lifecycle/{stage}/" in norm:
            return i
    return 99


def _pick_best_envelope_match(matches: list[str]) -> str:
    """Prefer valid frontmatter, then active/review over inbox."""
    if not matches:
        raise ValueError("empty matches")
    if len(matches) == 1:
        return matches[0]

    valid = [p for p in matches if _has_valid_fcop_frontmatter(p)]
    pool = valid if valid else matches
    pool.sort(key=lambda p: (_stage_rank(p), len(os.path.basename(p)), p))
    return pool[0]


def _resolve_write_report_task_id(project_root: str, task_id: str) -> str:
    """Prefer active/review copy when inbox stub is corrupt after rename+append."""
    token = (task_id or "").strip()
    if not token:
        return task_id
    if os.path.isabs(token) and os.path.isfile(token):
        return token

    basename = os.path.basename(_ensure_md(token))
    fcop_root = os.path.join(project_root, "fcop")
    stage_order = ("active", "review", "done", "inbox", "archive")

    for stage in stage_order:
        cand = os.path.join(fcop_root, "_lifecycle", stage, basename)
        if os.path.isfile(cand) and _has_valid_fcop_frontmatter(cand):
            return cand

    prefix = basename.replace(".md", "")
    if _TASK_PREFIX_RE.match(prefix):
        matches: list[str] = []
        for stage in stage_order:
            stage_dir = os.path.join(fcop_root, "_lifecycle", stage)
            if not os.path.isdir(stage_dir):
                continue
            for hit in glob.glob(os.path.join(stage_dir, prefix + "*.md")):
                if _has_valid_fcop_frontmatter(hit):
                    matches.append(hit)
        if matches:
            def _stage_rank(p: str) -> int:
                norm = p.replace("\\", "/")
                for i, stage in enumerate(stage_order):
                    if f"/_lifecycle/{stage}/" in norm:
                        return i
                return 99

            matches.sort(key=lambda p: (_stage_rank(p), len(os.path.basename(p))))
            return matches[0]

    return task_id


def _task_id_token_for_mcp(resolved: str) -> str:
    """MCP write_report expects a TASK id stem, not an absolute filesystem path."""
    token = (resolved or "").strip()
    if not token:
        return token
    base = os.path.basename(token.replace("\\", "/"))
    if base.lower().endswith(".md"):
        base = base[:-3]
    match = re.search(r"TASK-\d{8}-\d{3,}", base, re.IGNORECASE)
    if match:
        return match.group(0).upper()
    return token


def _normalize_report_status(status: str | None) -> str | None:
    """Map common agent aliases to FCoP v3 write_report status enum."""
    if status is None:
        return None
    raw = str(status).strip()
    if not raw:
        return None
    lowered = raw.lower()
    if lowered in ("completed", "complete", "finished", "success", "succeeded"):
        return "done"
    if lowered in ("in-progress", "inprogress", "running", "active"):
        return "in_progress"
    return raw


def normalize_write_report_args(project_root: str, args: dict) -> dict:
    """Normalize write_report args: body = markdown only; MCP generates frontmatter."""
    src = dict(args) if isinstance(args, dict) else {}

    task_id = _pick_alias(src, "task_id", "taskId", "filename", "id")
    if task_id:
        _quarantine_corrupt_inbox_stub(project_root, task_id)
        task_id = _resolve_write_report_task_id(project_root, task_id)
        task_id = _task_id_token_for_mcp(task_id)

    reporter = _pick_alias(src, "reporter", "sender")
    recipient = _pick_alias(src, "recipient")
    status = _normalize_report_status(_pick_alias(src, "status"))
    priority = _pick_alias(src, "priority")

    body_raw = src.get("body")
    body: str | None = None
    if body_raw is not None:
        body, had_fm = _strip_markdown_frontmatter(str(body_raw))
        if had_fm:
            print(
                "[fcop] write_report: stripped embedded YAML frontmatter from body "
                "(frontmatter is generated by MCP from task_id/reporter/recipient/status)",
                file=sys.stderr,
            )

    if not task_id and body is not None:
        reporter_norm = (reporter or "").strip().upper()
        recipient_norm = (recipient or "").strip().upper()
        status_norm = (status or "").strip().lower()
        if (
            reporter_norm == "PM"
            and recipient_norm == "ADMIN"
            and status_norm == "done"
        ):
            inferred = _infer_root_task_from_body(body)
            if not inferred:
                tk = _infer_thread_key_from_body(body)
                if tk:
                    draft = _load_close_admin_draft(project_root, thread_key=tk)
                    if draft:
                        hint = draft.get("write_report_hint") or {}
                        inferred = str(
                            hint.get("task_id") or draft.get("task_id") or ""
                        ).strip()
            if inferred:
                task_id = _task_id_token_for_mcp(
                    _resolve_write_report_task_id(project_root, inferred)
                )
                print(
                    f"[fcop] write_report: inferred task_id={task_id} "
                    "for PM→ADMIN done report",
                    file=sys.stderr,
                )

    out: dict = {}
    if task_id:
        out["task_id"] = task_id
    if reporter:
        out["reporter"] = reporter
    if recipient:
        out["recipient"] = recipient
    if body is not None:
        out["body"] = body
    if status:
        out["status"] = status
    if priority:
        out["priority"] = priority
    client_submission_id = _pick_alias(src, "client_submission_id", "clientSubmissionId")
    if client_submission_id:
        out["client_submission_id"] = client_submission_id

    return out


def _maybe_unescape_agent_body(text: str) -> str:
    """Decode literal \\n sequences models sometimes pass instead of newlines."""
    if not text or "\\n" not in text:
        return text
    head = text.lstrip()[:120]
    if head.startswith("\\n---") or head.startswith("---") or "\\n---" in head:
        return (
            text.replace("\\r\\n", "\n")
            .replace("\\n", "\n")
            .replace("\\t", "\t")
        )
    return text


def _parse_yaml_frontmatter_fields(raw_fm: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for line in raw_fm.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        m = re.match(r"^([a-zA-Z0-9_]+):\s*(.+)$", line)
        if not m:
            continue
        key, val = m.group(1), m.group(2).strip()
        if len(val) >= 2 and val[0] == val[-1] and val[0] in "\"'":
            val = val[1:-1]
        out[key] = val
    return out


def _read_file_frontmatter_fields(path: str) -> dict[str, str]:
    try:
        with open(path, encoding="utf-8") as f:
            raw = f.read(8192)
    except OSError:
        return {}
    if not raw.lstrip().startswith("---"):
        return {}
    stripped = raw.lstrip()
    end = stripped.find("\n---", 3)
    if end < 0:
        return {}
    return _parse_yaml_frontmatter_fields(stripped[3:end])


def _first_task_prefix_in_text(text: str) -> str | None:
    # `_TASK_PREFIX_RE` is anchored for validating a single token. References
    # may be a YAML/JSON list, so extraction must search anywhere in the text.
    m = re.search(r"TASK-\d{8}-\d{3,}", text or "", re.IGNORECASE)
    return m.group(0).upper() if m else None


def _infer_parent_reference_from_body(body: str) -> str | None:
    """Extract parent TASK id from markdown labels (PM often puts parent only in body)."""
    text = body or ""
    for pat in _PARENT_BODY_PATTERNS:
        m = pat.search(text)
        if m:
            return m.group(1).upper()
    return None


def _infer_root_task_from_body(body: str) -> str | None:
    """Prefer labeled root (主任务) over first TASK mention in PM→ADMIN close body."""
    text = body or ""
    for pat in _ROOT_BODY_PATTERNS:
        m = pat.search(text)
        if m and m.group(1):
            return m.group(1).replace(".md", "").strip()
    for m in _TASK_ID_LONG_RE.finditer(text):
        token = m.group(0).replace(".md", "").strip()
        if token.upper().endswith("-ADMIN-TO-PM"):
            return token
    return None


def _infer_thread_key_from_body(body: str) -> str:
    m = _THREAD_KEY_BODY_RE.search(body or "")
    return m.group(1).strip() if m else ""


def _load_close_admin_draft_for_root(project_root: str, root_token: str) -> dict | None:
    short = _first_task_prefix_in_text(root_token) or root_token.replace(".md", "")
    cand = os.path.join(
        project_root,
        ".codeflowmu",
        "pm-governance",
        "drafts",
        f"close-{short}.json",
    )
    if not os.path.isfile(cand):
        return None
    try:
        with open(cand, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return None


def _load_close_admin_draft(project_root: str, *, thread_key: str) -> dict | None:
    drafts_dir = os.path.join(project_root, ".codeflowmu", "pm-governance", "drafts")
    if not os.path.isdir(drafts_dir) or not thread_key:
        return None
    for path in glob.glob(os.path.join(drafts_dir, "close-*.json")):
        try:
            with open(path, encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, json.JSONDecodeError):
            continue
        if str(data.get("thread_key") or "") == thread_key:
            return data
    return None


def _task_file_stem(path_or_id: str) -> str:
    return os.path.basename(_ensure_md(path_or_id)).replace(".md", "")


def _dedupe_ref_ids(ids: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for raw in ids:
        token = raw.replace(".md", "").strip()
        if not token or token in seen:
            continue
        seen.add(token)
        out.append(token)
    return out


def _collect_pm_admin_references(
    project_root: str,
    root_task_id: str,
    draft: dict | None,
) -> list[str]:
    refs: list[str] = []
    root_full = _task_id_token_for_mcp(
        _resolve_write_report_task_id(project_root, root_task_id)
    )
    if root_full:
        refs.append(root_full)

    if draft:
        for item in draft.get("downstream_reports") or []:
            if not isinstance(item, dict):
                continue
            child_task = item.get("task_id")
            if child_task:
                resolved = _task_id_token_for_mcp(
                    _resolve_write_report_task_id(project_root, str(child_task))
                )
                if resolved:
                    refs.append(resolved)
            report_id = item.get("report_id") or item.get("filename", "")
            if report_id:
                refs.append(str(report_id).replace(".md", ""))

    root_short = _first_task_prefix_in_text(root_task_id) or root_task_id
    for stage in _LIFECYCLE_STAGES:
        stage_dir = os.path.join(project_root, "fcop", "_lifecycle", stage)
        if not os.path.isdir(stage_dir):
            continue
        for hit in glob.glob(os.path.join(stage_dir, "TASK-*.md")):
            fm = _read_file_frontmatter_fields(hit)
            parent = fm.get("parent", "")
            parent_short = _first_task_prefix_in_text(parent) or parent
            if parent_short and parent_short.upper() == root_short.upper():
                refs.append(_task_file_stem(hit))

    return _dedupe_ref_ids(refs)


def _enrich_pm_admin_report_frontmatter(
    project_root: str, report_path: str, args: dict
) -> None:
    from fcop_sdk.protocol import read_fcop_file, write_fcop_file

    fm, body = read_fcop_file(report_path)
    reporter = str(
        fm.get("reporter") or fm.get("sender") or args.get("reporter") or ""
    ).strip().upper()
    recipient = str(fm.get("recipient") or args.get("recipient") or "").strip().upper()
    status = str(fm.get("status") or args.get("status") or "").strip().lower()

    if reporter != "PM" or recipient != "ADMIN" or status != "done":
        return

    body_text = args.get("body") or body
    task_id = str(fm.get("task_id") or args.get("task_id") or "").strip()
    draft: dict | None = None

    if not task_id:
        labeled = _infer_root_task_from_body(body_text)
        if labeled:
            task_id = labeled
            draft = _load_close_admin_draft_for_root(project_root, labeled)
        else:
            thread_key = _infer_thread_key_from_body(body_text)
            if thread_key:
                draft = _load_close_admin_draft(project_root, thread_key=thread_key)
                if draft:
                    hint = draft.get("write_report_hint") or {}
                    task_id = str(
                        hint.get("task_id") or draft.get("task_id") or ""
                    ).strip()
    else:
        draft = _load_close_admin_draft_for_root(project_root, task_id)

    if task_id:
        task_id = _task_id_token_for_mcp(
            _resolve_write_report_task_id(project_root, task_id)
        )

    if not task_id:
        return

    basename = os.path.basename(report_path)
    report_id = basename[:-3] if basename.lower().endswith(".md") else basename

    thread_key = str(fm.get("thread_key") or "").strip()
    if not thread_key:
        thread_key = _infer_thread_key_from_body(body_text)
    if not thread_key and draft:
        thread_key = str(draft.get("thread_key") or "")
    if not thread_key:
        root_path = _resolve_write_report_task_id(project_root, task_id)
        if os.path.isfile(root_path):
            thread_key = _read_file_frontmatter_fields(root_path).get("thread_key", "") or ""

    references = _collect_pm_admin_references(project_root, task_id, draft)
    references.extend(
        match.group(0).replace(".md", "")
        for match in re.finditer(
            r"(?:TASK|REPORT)-\d{8}-\d{3,}(?:-[A-Za-z0-9_-]+)*(?:\.md)?",
            str(body_text),
            re.IGNORECASE,
        )
    )
    references = _dedupe_ref_ids(references)

    fm["protocol"] = fm.get("protocol") or "fcop"
    fm["version"] = fm.get("version") or 1
    fm["kind"] = "report"
    fm["report_id"] = report_id
    fm["sender"] = fm.get("sender") or "PM"
    fm["reporter"] = fm.get("reporter") or fm["sender"]
    fm["recipient"] = "ADMIN"
    fm["status"] = "done"
    fm["task_id"] = task_id
    if thread_key:
        fm["thread_key"] = thread_key
    fm["references"] = references

    write_fcop_file(report_path, fm, body)


_PM_DOWNSTREAM_RECIPIENTS = frozenset({"DEV", "QA", "OPS", "EVAL"})


def _filename_is_admin_to_pm(path: str) -> bool:
    base = os.path.basename(path or "")
    return bool(re.search(r"-ADMIN-to-PM(?:\.md)?$", base, re.I))


def _resolve_pm_child_parent_fields(
    project_root: str,
    sender: str,
    recipient: str,
    ref_token: str,
) -> tuple[str, str]:
    """When PM dispatches DEV/QA/OPS/EVAL under ADMIN→PM, return (parent_id, thread_key)."""
    if (sender or "PM").upper() != "PM":
        return "", ""
    rec = (recipient or "").upper().strip()
    if rec not in _PM_DOWNSTREAM_RECIPIENTS:
        return "", ""
    token = (ref_token or "").replace(".md", "").strip()
    if not token or not _TASK_PREFIX_RE.match(token):
        return "", ""
    parent_path = _resolve_write_report_task_id(project_root, token)
    if not os.path.isfile(parent_path) or not _filename_is_admin_to_pm(parent_path):
        return "", ""
    parent_fm = _read_file_frontmatter_fields(parent_path)
    tk = parent_fm.get("thread_key", "") or ""
    return token, tk


def _infer_referenced_dev_dependencies(
    project_root: str,
    sender: str,
    recipient: str,
    parent_id: str,
    reference_tokens: list[str],
) -> list[str]:
    """Infer DEV prerequisites for PM -> QA/OPS validation tasks.

    PM commonly creates the DEV, QA and OPS legs in one planning turn.  The
    QA/OPS task references the DEV leg, but older prompts did not always add
    ``depends_on``.  Resolve only referenced sibling PM -> DEV tasks under the
    same parent; unrelated references remain context and never become gates.
    """
    if (sender or "PM").upper() != "PM":
        return []
    if (recipient or "").upper().strip() not in {"QA", "OPS"}:
        return []

    parent_short = _first_task_prefix_in_text(parent_id) or parent_id
    inferred: list[str] = []
    for reference in reference_tokens:
        ref_short = _first_task_prefix_in_text(reference) or reference
        if not ref_short or ref_short.upper() == parent_short.upper():
            continue
        task_path = _resolve_write_report_task_id(project_root, ref_short)
        if not os.path.isfile(task_path):
            continue
        task_fm = _read_file_frontmatter_fields(task_path)
        if str(task_fm.get("sender") or "").upper() != "PM":
            continue
        if str(task_fm.get("recipient") or "").upper() != "DEV":
            continue
        candidate_parent = _first_task_prefix_in_text(
            str(task_fm.get("parent") or "")
        ) or str(task_fm.get("parent") or "")
        if (
            parent_short
            and candidate_parent
            and candidate_parent.upper() != parent_short.upper()
        ):
            continue
        candidate_id = _first_task_prefix_in_text(
            str(task_fm.get("task_id") or ref_short)
        ) or ref_short
        if candidate_id not in inferred:
            inferred.append(candidate_id)
    return inferred


def normalize_write_task_args(project_root: str, args: dict) -> dict:
    """Normalize write_task args: body = markdown only; FCoP-0003 parent vs references."""
    src = dict(args) if isinstance(args, dict) else {}

    sender = _pick_alias(src, "sender") or "PM"
    recipient = _pick_alias(src, "recipient")
    subject = _pick_alias(src, "subject", "title")
    priority = _pick_alias(src, "priority") or "P2"
    thread_key = _pick_alias(src, "thread_key", "threadKey") or ""
    explicit_parent = _pick_alias(src, "parent", "parent_task", "parentTask") or ""
    references_value = src.get("references", src.get("reference", ""))
    references = references_value or ""
    reference_tokens = list(dict.fromkeys(
        token.replace(".md", "")
        for token in re.findall(r"TASK-\d{8}-\d{3,}(?:-[A-Za-z0-9_.-]+-to-[A-Za-z0-9_.-]+)?", str(references_value), re.I)
    ))
    depends_value = src.get("depends_on", src.get("dependsOn", []))
    depends_on = list(dict.fromkeys(
        token.replace(".md", "")
        for token in re.findall(r"TASK-\d{8}-\d{3,}(?:-[A-Za-z0-9_.-]+-to-[A-Za-z0-9_.-]+)?", str(depends_value), re.I)
    ))

    body_raw = src.get("body")
    body = ""
    embedded_fm: dict[str, str] = {}
    if body_raw is not None:
        text = _maybe_unescape_agent_body(str(body_raw))
        body, had_fm = _strip_markdown_frontmatter(text)
        if had_fm:
            stripped = text.lstrip()
            end = stripped.find("\n---", 3)
            if end >= 0:
                embedded_fm = _parse_yaml_frontmatter_fields(stripped[3:end])
            print(
                "[fcop] write_task: stripped embedded YAML frontmatter from body "
                "(MCP generates frontmatter; use parent= / references= for lineage)",
                file=sys.stderr,
            )
            emb_parent = embedded_fm.get("parent") or ""
            if emb_parent and emb_parent.lower() not in ("null", "none", ""):
                if not explicit_parent:
                    explicit_parent = emb_parent
            if not references:
                references = embedded_fm.get("references") or ""
            if not thread_key:
                thread_key = embedded_fm.get("thread_key", "") or ""
            if not recipient:
                recipient = embedded_fm.get("recipient")
            if not sender or sender == "PM":
                embedded_sender = embedded_fm.get("sender")
                if embedded_sender:
                    sender = embedded_sender
            if not priority or priority == "P2":
                embedded_pri = embedded_fm.get("priority")
                if embedded_pri:
                    priority = embedded_pri

    if not references and body:
        inferred = _infer_parent_reference_from_body(body)
        if inferred:
            references = inferred
            print(
                "[fcop] write_task: inferred references from body label "
                f"({references}); prefer references= MCP arg",
                file=sys.stderr,
            )

    ref_token = ""
    for candidate in (explicit_parent, references):
        if not candidate:
            continue
        tok = _first_task_prefix_in_text(str(candidate)) or str(candidate).split(",")[0].strip()
        tok = tok.replace(".md", "")
        if _TASK_PREFIX_RE.match(tok):
            ref_token = tok
            break

    if ref_token:
        parent_path = _resolve_write_report_task_id(project_root, ref_token)
        if os.path.isfile(parent_path):
            parent_fm = _read_file_frontmatter_fields(parent_path)
            parent_thread_key = parent_fm.get("thread_key", "") or ""
            if parent_thread_key:
                # Strong lineage wins over an accidentally copied task id.
                thread_key = parent_thread_key

    refs_out = ref_token
    if not refs_out and references:
        refs_out = _first_task_prefix_in_text(str(references)) or str(references).split(",")[0].strip()
        refs_out = refs_out.replace(".md", "")

    parent_id, parent_tk = _resolve_pm_child_parent_fields(
        project_root,
        sender,
        recipient or "",
        refs_out or ref_token,
    )
    if parent_tk and not thread_key:
        thread_key = parent_tk

    if not depends_on:
        depends_on = _infer_referenced_dev_dependencies(
            project_root,
            sender,
            recipient or "",
            parent_id,
            reference_tokens,
        )
        if depends_on:
            print(
                "[fcop] write_task: inferred depends_on from referenced "
                f"same-parent DEV task(s): {depends_on}",
                file=sys.stderr,
            )

    if not subject:
        for line in body.splitlines():
            stripped_line = line.strip()
            if stripped_line.startswith("#"):
                subject = stripped_line.lstrip("#").strip()[:120]
                break
        if not subject:
            first = next((ln.strip() for ln in body.splitlines() if ln.strip()), "")
            subject = (first[:120] if first else "子任务")

    out: dict = {
        "sender": sender,
        "recipient": recipient or "",
        "subject": subject,
        "body": body,
        "priority": priority,
    }
    if thread_key:
        out["thread_key"] = thread_key
    if parent_id:
        out["parent"] = parent_id
    if reference_tokens:
        out["references"] = reference_tokens
    elif refs_out:
        out["references"] = refs_out
    if depends_on:
        out["depends_on"] = depends_on

    risk = _pick_alias(src, "risk_level", "riskLevel")
    if risk:
        out["risk_level"] = risk

    return out


def _now_iso() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def _today_yyyymmdd() -> str:
    from datetime import datetime

    return datetime.now().strftime("%Y%m%d")


def _next_sequence(project_root: str, prefix: str) -> str:
    fcop_root = os.path.join(project_root, "fcop")
    hits: list[str] = []
    for sub in (
        "tasks",
        "reports",
        "_lifecycle/inbox",
        "_lifecycle/active",
        "_lifecycle/review",
        "_lifecycle/done",
        "_lifecycle/archive",
    ):
        hits.extend(glob.glob(os.path.join(fcop_root, sub.replace("/", os.sep), prefix + "-*.md")))
    max_seq = 0
    for hit in hits:
        m = re.match(r"^[A-Z]+-\d{8}-(\d{3,})", os.path.basename(hit))
        if m:
            max_seq = max(max_seq, int(m.group(1)))
    return f"{max_seq + 1:03d}"


def _yaml_value(value: object) -> str:
    if value is None:
        return ""
    text = str(value).replace("\r\n", "\n").replace("\r", "\n")
    if "\n" in text:
        return "|\n" + "\n".join(f"  {line}" for line in text.split("\n"))
    if text == "" or any(ch in text for ch in (":", "#", "[", "]", "{", "}", '"', "'")):
        return json.dumps(text, ensure_ascii=False)
    return text


def _write_frontmatter_file(path: str, fields: dict[str, object], body: str) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    lines = ["---"]
    for key, value in fields.items():
        lines.append(f"{key}: {_yaml_value(value)}")
    lines.extend(["---", "", body.strip() or "(no body)", ""])
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write("\n".join(lines))


def _report_content_hash(body: str) -> str:
    """Stable identity for an idempotent retry of the same report content."""
    normalized = (body or "").replace("\r\n", "\n").replace("\r", "\n").strip()
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def _read_markdown_body(path: str) -> str:
    try:
        with open(path, encoding="utf-8") as fh:
            raw = fh.read()
    except OSError:
        return ""
    if not raw.lstrip().startswith("---"):
        return raw
    stripped = raw.lstrip()
    end = stripped.find("\n---", 3)
    if end < 0:
        return raw
    return stripped[end + 4 :].lstrip("\r\n")


def _report_history_paths(project_root: str) -> list[str]:
    fcop_root = os.path.join(project_root, "fcop")
    paths: list[str] = []
    for sub in (
        "reports",
        "_lifecycle/review",
        "_lifecycle/done",
        "_lifecycle/archive",
    ):
        paths.extend(
            glob.glob(
                os.path.join(fcop_root, sub.replace("/", os.sep), "REPORT-*.md")
            )
        )
    return sorted(set(os.path.normpath(path) for path in paths))


def _fallback_write_report(project_root: str, args: dict, reason: Exception) -> dict:
    reporter = (_pick_alias(args, "reporter", "sender") or "PM").upper()
    recipient = (_pick_alias(args, "recipient") or "ADMIN").upper()
    task_id_raw = (_pick_alias(args, "task_id", "taskId", "filename", "id") or "").replace(".md", "")
    task_match = re.search(r"TASK-\d{8}-\d{3,}", task_id_raw, re.IGNORECASE)
    task_id = task_match.group(0).upper() if task_match else task_id_raw
    status = _normalize_report_status(_pick_alias(args, "status")) or "in_progress"
    body = str(args.get("body") or "")
    resolved_task_path = _resolve_write_report_task_id(project_root, task_id)
    if not task_id or not os.path.isfile(resolved_task_path):
        return {
            "ok": False,
            "fallback": "write_report",
            "reason": "task_not_found",
            "detail": str(reason),
            "task_id": task_id,
        }

    task_fields = _read_file_frontmatter_fields(resolved_task_path)
    try:
        rework_round = max(0, int(task_fields.get("reopened_count") or 0))
    except (TypeError, ValueError):
        rework_round = 0
    content_hash = _report_content_hash(body)
    client_submission_id = _pick_alias(args, "client_submission_id", "clientSubmissionId") or ""
    reports_dir = os.path.join(project_root, "fcop", "reports")
    matching_reports: list[tuple[str, dict[str, str]]] = []
    for existing_path in _report_history_paths(project_root):
        existing = _read_file_frontmatter_fields(existing_path)
        existing_task_raw = str(existing.get("source_task_id") or existing.get("task_id") or "").replace(".md", "")
        existing_task_match = re.search(r"TASK-\d{8}-\d{3,}", existing_task_raw, re.IGNORECASE)
        existing_task = existing_task_match.group(0).upper() if existing_task_match else existing_task_raw
        existing_reporter = str(existing.get("sender") or existing.get("reporter") or "").upper()
        existing_recipient = str(existing.get("recipient") or "").upper()
        existing_status = _normalize_report_status(existing.get("status")) or ""
        if (
            task_id
            and existing_task == task_id
            and existing_reporter == reporter
            and existing_recipient == recipient
            and existing_status == status
        ):
            matching_reports.append((existing_path, existing))
            existing_client_id = str(existing.get("client_submission_id") or "")
            try:
                existing_round = max(0, int(existing.get("rework_round") or 0))
            except (TypeError, ValueError):
                existing_round = 0
            existing_hash = str(existing.get("content_hash") or "") or _report_content_hash(
                _read_markdown_body(existing_path)
            )
            same_attempt = bool(
                client_submission_id
                and existing_client_id
                and client_submission_id == existing_client_id
            )
            same_round_and_content = (
                existing_round == rework_round and existing_hash == content_hash
            )
            if not same_attempt and not same_round_and_content:
                continue
            return {
                "ok": True,
                "fallback": "write_report",
                "deduplicated": True,
                "reason": str(reason),
                "filename": os.path.basename(existing_path),
                "path": existing_path,
                "rework_round": rework_round,
            }
    day = _today_yyyymmdd()
    seq = _next_sequence(project_root, f"REPORT-{day}")
    filename = f"REPORT-{day}-{seq}-{reporter}-to-{recipient}.md"
    path = os.path.join(project_root, "fcop", "reports", filename)
    matching_reports.sort(key=lambda item: (os.path.getmtime(item[0]), item[0]))
    previous_path = matching_reports[-1][0] if matching_reports else ""
    previous_id = os.path.basename(previous_path).removesuffix(".md") if previous_path else ""
    revision = len(matching_reports) + 1
    fields = {
        "protocol": "fcop",
        "version": "1.0",
        "source_task_id": task_id,
        "task_id": task_id,
        "sender": reporter,
        "reporter": reporter,
        "recipient": recipient,
        "status": status,
        "revision": revision,
        "rework_round": rework_round,
        "submission_attempt": revision,
        "content_hash": content_hash,
        "created_at": _now_iso(),
        "writer": "codeflowmu-one-shot-fallback",
    }
    session_id = _pick_alias(args, "session_id", "sessionId")
    run_id = _pick_alias(args, "run_id", "runId")
    evidence_refs = args.get("evidence_refs") or args.get("evidenceRefs")
    if session_id:
        fields["session_id"] = session_id
    if run_id:
        fields["run_id"] = run_id
    if evidence_refs:
        fields["evidence_refs"] = (
            [str(value) for value in evidence_refs if value]
            if isinstance(evidence_refs, list)
            else [str(evidence_refs)]
        )
    if client_submission_id:
        fields["client_submission_id"] = client_submission_id
    if previous_id:
        fields["revision_of"] = previous_id
        fields["supersedes"] = previous_id
    _write_frontmatter_file(path, fields, body)
    try:
        _enrich_pm_admin_report_frontmatter(project_root, path, args)
    except Exception as exc:
        print(f"[fcop] report enrichment warning: {exc}", file=sys.stderr)
    _ledger_rebuild(project_root)
    return {
        "ok": True,
        "fallback": "write_report",
        "reason": str(reason),
        "filename": filename,
        "path": path,
        "revision": revision,
        "rework_round": rework_round,
        **({"revision_of": previous_id, "supersedes": previous_id} if previous_id else {}),
    }


def _fallback_write_task(project_root: str, args: dict, reason: Exception) -> dict:
    sender = (_pick_alias(args, "sender") or "PM").upper()
    recipient = (_pick_alias(args, "recipient") or "DEV").upper()
    subject = _pick_alias(args, "subject", "title") or "Task"
    priority = _pick_alias(args, "priority") or "P2"
    thread_key = _pick_alias(args, "thread_key", "threadKey") or ""
    parent = _pick_alias(args, "parent", "parent_task", "parentTask") or ""
    references = args.get("references", args.get("reference", ""))
    depends_on = args.get("depends_on", args.get("dependsOn", []))
    body = str(args.get("body") or "")
    day = _today_yyyymmdd()
    seq = _next_sequence(project_root, f"TASK-{day}")
    filename = f"TASK-{day}-{seq}-{sender}-to-{recipient}.md"
    path = os.path.join(project_root, "fcop", "_lifecycle", "inbox", filename)
    fields = {
        "protocol": "fcop",
        "version": "1.0",
        "sender": sender,
        "recipient": recipient,
        "task_id": f"TASK-{day}-{seq}",
        "priority": priority,
        "thread_key": thread_key,
        "parent": parent,
        "references": references,
        "depends_on": depends_on,
        "state": "inbox",
        "created_at": _now_iso(),
        "writer": "codeflowmu-one-shot-fallback",
    }
    _write_frontmatter_file(path, fields, f"# {subject}\n\n{body}")
    _ledger_rebuild(project_root)
    return {
        "ok": True,
        "fallback": "write_task",
        "reason": str(reason),
        "filename": filename,
        "path": path,
    }


_PATROL_LANG_TOOLS = frozenset({"fcop_report", "fcop_check", "get_team_status"})
_VALID_FCOP_LANG = frozenset({"zh", "en"})


def normalize_patrol_tool_args(tool: str, args: dict) -> dict:
    """fcop-mcp 3.2.x patrol tools only accept optional lang — strip legacy role/scope keys."""
    if tool not in _PATROL_LANG_TOOLS:
        return args if isinstance(args, dict) else {}
    src = dict(args) if isinstance(args, dict) else {}
    out: dict = {}
    lang = _pick_alias(src, "lang", "language")
    if lang:
        lang_norm = str(lang).strip().lower()
        if lang_norm in _VALID_FCOP_LANG:
            out["lang"] = lang_norm
        else:
            print(
                f"[fcop] {tool}: ignored invalid lang={lang!r} (expected zh or en)",
                file=sys.stderr,
            )
    stripped = [k for k in src if k not in out and k not in ("lang", "language")]
    if stripped:
        print(
            f"[fcop] {tool}: stripped unsupported args {stripped} "
            "(MCP only accepts optional lang)",
            file=sys.stderr,
        )
    return out


def _pick_alias(args: dict, *keys: str) -> str | None:
    for k in keys:
        v = args.get(k)
        if v is not None and str(v).strip():
            return str(v).strip()
    return None


def _resolve_envelope_path(token: str, *, kind: str) -> str | None:
    """Resolve TASK-/REPORT- prefix or bare id to an on-disk basename path."""
    token = _ensure_md(token)
    if not token:
        return None

    # Already a path relative to project or absolute file that exists.
    if os.path.isfile(token):
        return token
    cand = os.path.join(os.getcwd(), token.replace("/", os.sep))
    if os.path.isfile(cand):
        return cand

    basename = os.path.basename(token)
    dirs = _lifecycle_dirs()
    if not dirs:
        return None

    # Exact basename match — collect all hits, prefer valid FM + active stage.
    exact_hits: list[str] = []
    for d in dirs:
        exact = os.path.join(d, basename)
        if os.path.isfile(exact):
            exact_hits.append(exact)
        for hit in glob.glob(os.path.join(d, "**", basename), recursive=True):
            if os.path.isfile(hit):
                exact_hits.append(hit)
    if exact_hits:
        # De-dupe while preserving order
        seen: set[str] = set()
        unique = []
        for h in exact_hits:
            norm = os.path.normpath(h)
            if norm not in seen:
                seen.add(norm)
                unique.append(h)
        return _pick_best_envelope_match(unique)

    # Prefix id only: TASK-20260529-001 → TASK-20260529-001-*.md
    prefix = basename
    if prefix.upper().endswith(".MD"):
        prefix = prefix[:-3]
    pat = _TASK_PREFIX_RE if kind == "task" else _REPORT_PREFIX_RE
    if not pat.match(prefix):
        return None

    matches: list[str] = []
    for d in dirs:
        pattern = os.path.join(d, "**", prefix + "*.md")
        matches.extend(glob.glob(pattern, recursive=True))

    if not matches:
        return None
    if len(matches) == 1:
        return matches[0]
    valid = [p for p in matches if _has_valid_fcop_frontmatter(p)]
    pool = valid if valid else matches
    pool.sort(key=lambda p: (_stage_rank(p), len(os.path.basename(p)), p))
    return pool[0]


def _reject_wrong_envelope_tool(tool: str, args: dict) -> str | None:
    """read_task / inspect_task only accept TASK-*.md, not ISSUE/REPORT."""
    if tool not in ("read_task", "inspect_task"):
        return None
    token = _pick_alias(args, "filename", "task_id", "taskId", "id") or ""
    base = os.path.basename(_ensure_md(str(token)))
    upper = base.upper()
    if upper.startswith("ISSUE-"):
        return (
            f"错误：{tool} 仅适用于 TASK-*.md，不能用于 ISSUE 文件「{base}」。"
            "请改用 list_issues；ISSUE 正文不在 read_task/inspect_task 路由内。"
        )
    if upper.startswith("REPORT-"):
        return (
            f"错误：{tool} 不能用于 REPORT 文件「{base}」。"
            "请改用 read_report，参数 filename 为 REPORT-*.md 或前缀。"
        )
    return None


def normalize_tool_args(tool: str, args: dict) -> dict:
    """Map task_id/report_id → filename and resolve lifecycle paths for read_* tools."""
    if not isinstance(args, dict):
        return args

    out = dict(args)
    if tool not in _FILENAME_TOOLS:
        return out

    if tool in ("read_task", "inspect_task", "claim", "submit", "finish", "approve", "reject"):
        alias = _pick_alias(out, "filename", "task_id", "taskId", "id")
        kind = "task"
    elif tool == "read_report":
        alias = _pick_alias(out, "filename", "report_id", "reportId", "id")
        kind = "report"
    elif tool == "archive_task":
        alias = _pick_alias(out, "filename", "task_id", "taskId", "id")
        kind = "task"
    else:
        return out

    if not alias:
        return out

    if kind == "task":
        _quarantine_corrupt_inbox_stub(os.getcwd(), alias)

    resolved = _resolve_envelope_path(alias, kind=kind)
    if resolved:
        out["filename"] = os.path.basename(resolved)
        # read_task / read_report accept basename; fcop resolves stage internally.
        for k in ("task_id", "taskId", "report_id", "reportId", "id"):
            out.pop(k, None)
    else:
        out["filename"] = _ensure_md(alias)
        for k in ("task_id", "taskId", "report_id", "reportId", "id"):
            out.pop(k, None)

    return out


def main() -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

    if len(sys.argv) < 3:
        print(json.dumps({"error": "usage: fcop_invoke_once.py <project_root> <payload_json>"}))
        sys.exit(2)

    project_root = os.path.abspath(sys.argv[1])
    os.chdir(project_root)
    _ensure_fcop_sdk_importable(project_root)

    payload = _parse_payload(sys.argv)
    tool = payload.get("tool")
    args = payload.get("arguments") or {}
    if not tool or not isinstance(tool, str):
        print(json.dumps({"error": "missing tool name"}))
        sys.exit(2)
    if not isinstance(args, dict):
        print(json.dumps({"error": "arguments must be an object"}))
        sys.exit(2)

    if tool == "create_task":
        tool = "write_task"

    report_runtime_metadata: dict = {}
    if tool == "write_report":
        report_runtime_metadata = {
            key: args[key]
            for key in ("session_id", "sessionId", "run_id", "runId", "evidence_refs", "evidenceRefs")
            if key in args
        }
        tid = _pick_alias(args, "task_id", "taskId", "filename", "id")
        if tid:
            _quarantine_corrupt_inbox_stub(project_root, tid)
        args = normalize_write_report_args(project_root, args)

    if tool == "write_task":
        args = normalize_write_task_args(project_root, args)
        # CodeFlowMu runtime dispatch watches fcop/_lifecycle/inbox.
        # The upstream fcop write_task may land in legacy fcop/tasks, which is
        # visible in the ledger but does not wake DEV/OPS/QA.  For the app
        # bridge, always emit lifecycle-inbox TASK files.
        print(
            json.dumps(
                _fallback_write_task(
                    project_root,
                    args,
                    RuntimeError("codeflowmu lifecycle inbox writer"),
                ),
                ensure_ascii=False,
                default=str,
            )
        )
        return

    if tool in _PATROL_LANG_TOOLS:
        args = normalize_patrol_tool_args(tool, args)

    if tool == "list_tasks":
        try:
            print(_handle_list_tasks(project_root, args))
        except Exception as exc:
            print(
                json.dumps({"error": str(exc), "tool": tool, "args": args}, ensure_ascii=False),
                file=sys.stderr,
            )
            sys.exit(1)
        return

    if tool in _KERNEL_EXCLUSIVE_TOOLS:
        try:
            from fcop_sdk.lifecycle_bridge import (
                format_kernel_result,
                invoke_lifecycle_kernel,
            )

            data = invoke_lifecycle_kernel(project_root, tool, args)
            print(format_kernel_result(data))
        except Exception as exc:
            print(
                json.dumps(
                    {"error": str(exc), "tool": tool, "args": args, "kernel": True},
                    ensure_ascii=False,
                ),
                file=sys.stderr,
            )
            sys.exit(1)
        return

    args = normalize_tool_args(tool, args)

    wrong = _reject_wrong_envelope_tool(tool, args)
    if wrong:
        print(wrong, file=sys.stderr)
        sys.exit(1)

    from fcop_mcp import server as s  # noqa: WPS433 — runtime import

    fn = getattr(s, tool, None)
    if fn is None:
        print(json.dumps({"error": f"unknown tool: {tool}"}, ensure_ascii=False))
        sys.exit(2)

    try:
        out = fn(**args)
        if tool in ("write_report", "write_task") and isinstance(out, str):
            text = out.strip()
            if "TaskNotFoundError" in text or text.lower().startswith("错误 / error"):
                fallback = (
                    _fallback_write_report(project_root, {**args, **report_runtime_metadata}, RuntimeError(text))
                    if tool == "write_report"
                    else _fallback_write_task(project_root, args, RuntimeError(text))
                )
                print(json.dumps(fallback, ensure_ascii=False, default=str))
                return
        if tool == "write_report":
            _post_write_report(project_root, {**args, **report_runtime_metadata}, out)
        elif tool == "write_task":
            _post_write_task(project_root, args, out)
        elif tool in _LIFECYCLE_MUTATION_TOOLS and tool not in _KERNEL_EXCLUSIVE_TOOLS:
            _ledger_rebuild(project_root)
        if isinstance(out, str):
            print(out)
        else:
            print(json.dumps(out, ensure_ascii=False, default=str))
    except TypeError as exc:
        if tool == "write_report":
            print(json.dumps(_fallback_write_report(project_root, {**args, **report_runtime_metadata}, exc), ensure_ascii=False, default=str))
            return
        if tool == "write_task":
            print(json.dumps(_fallback_write_task(project_root, args, exc), ensure_ascii=False, default=str))
            return
        # Typical when model passes task_id but MCP only accepts filename.
        hint = ""
        if tool in _FILENAME_TOOLS:
            hint = " (提示: read_task/read_report/inspect_task 需要 filename，可为 TASK-xxx-...md 或前缀 TASK-20260529-001)"
        print(
            json.dumps({"error": str(exc) + hint, "tool": tool, "args": args}, ensure_ascii=False),
            file=sys.stderr,
        )
        sys.exit(1)
    except Exception as exc:
        if tool == "write_report":
            print(json.dumps(_fallback_write_report(project_root, {**args, **report_runtime_metadata}, exc), ensure_ascii=False, default=str))
            return
        if tool == "write_task":
            print(json.dumps(_fallback_write_task(project_root, args, exc), ensure_ascii=False, default=str))
            return
        print(
            json.dumps({"error": str(exc), "tool": tool, "args": args}, ensure_ascii=False),
            file=sys.stderr,
        )
        sys.exit(1)


if __name__ == "__main__":
    main()
