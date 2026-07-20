#!/usr/bin/env python3
"""QA panel UI checks for TASK-20260611-023."""
import json
import urllib.error
import urllib.request

BASE = "http://127.0.0.1:18766"


def fetch(path, method="GET", body=None):
    data = None
    headers = {}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=15) as r:
        return r.status, json.loads(r.read().decode("utf-8", "replace"))


def fetch_text(path):
    with urllib.request.urlopen(BASE + path, timeout=15) as r:
        return r.read().decode("utf-8", "replace")


def main():
    html = fetch_text("/")
    checks = [
        ("重新扫描", "diag_rescan_text"),
        ("一键解除卡死", "unstick_text"),
        ("git-page-commit-btn", "git_page_commit_btn"),
        ("git-backup-section", "git_backup_section"),
        ("启用自动提交", "auto_commit_label"),
        ("自动提交已启用", "misleading_auto_commit_enabled"),
        ("实验", "experimental_label"),
        ("未启用", "not_enabled_label"),
        ("file_without_ledger", "file_without_ledger_literal"),
        ("btn-proj-unstick-scan", "proj_unstick_btn"),
        ("data-diag-rescan", "diag_rescan_attr"),
    ]
    print("=== HTML presence ===")
    for needle, key in checks:
        print(f"{key}: {'FOUND' if needle in html else 'MISSING'}")

    print("\n=== API probes ===")
    for path, method in [
        ("/api/v2/health", "GET"),
        ("/api/v2/diagnostics", "GET"),
        ("/api/v2/diagnostics?confirmed=1", "GET"),
        ("/api/v2/diagnostics/rescan", "POST"),
        ("/api/v2/git/status", "GET"),
    ]:
        try:
            if method == "GET":
                status, body = fetch(path)
            else:
                status, body = fetch(path, method="POST", body={})
            snippet = json.dumps(body, ensure_ascii=False)[:240]
            print(f"{path} {status} {snippet}")
        except urllib.error.HTTPError as e:
            print(f"{path} HTTP {e.code} {e.read()[:200]!r}")
        except Exception as e:
            print(f"{path} ERR {e}")

    print("\n=== queue unstick signals ===")
    _, q = fetch("/api/v2/queue")
    keys = [
        "pm_downstream_receipt_phase",
        "pm_downstream_queue_state",
        "pm_queue_state",
        "pm_stale_release",
        "autoRecovery",
    ]
    for k in keys:
        if k in q:
            print(f"{k}: {json.dumps(q[k], ensure_ascii=False)[:300]}")


if __name__ == "__main__":
    main()
