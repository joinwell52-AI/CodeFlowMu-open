#!/usr/bin/env python3
"""QA TASK-20260611-023 Panel UI verification probes."""
import json
import time
import urllib.error
import urllib.request

BASE = "http://127.0.0.1:18766"


def get(path: str):
    r = urllib.request.urlopen(BASE + path, timeout=15)
    return json.loads(r.read().decode())


def post(path: str, data=None):
    body = json.dumps(data or {}).encode()
    req = urllib.request.Request(
        BASE + path,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        r = urllib.request.urlopen(req, timeout=15)
        raw = r.read().decode()
        try:
            return r.status, json.loads(raw)
        except json.JSONDecodeError:
            return r.status, {"raw": raw[:800]}
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return e.code, json.loads(raw)
        except json.JSONDecodeError:
            return e.code, {"raw": raw[:800]}


def main():
    html = urllib.request.urlopen(BASE + "/", timeout=15).read().decode("utf-8", "replace")
    checks = [
        "重新扫描",
        "一键解除卡死",
        "一键提交",
        "启用自动提交",
        "自动提交已启用",
        "git-commit-btn",
        "git-page-commit-btn",
        "btn-proj-unstick-scan",
        "tdp-unstick-btn",
        "data-diag-rescan",
    ]
    print("=== Panel HTML checks ===")
    for c in checks:
        print(f"{c}: {'FOUND' if c in html else 'MISSING'}")

    print("\n=== diagnostics triple poll ===")
    for i in range(3):
        d = get("/api/v2/diagnostics")
        s = d.get("summary", {})
        print(
            f"poll{i+1}: file_without_ledger={s.get('file_without_ledger_count', 0)} "
            f"total={s.get('diagnostics_count', 0)}"
        )
        time.sleep(1)

    print("\n=== rescan ===")
    print(json.dumps(post("/api/v2/diagnostics/rescan")[1], ensure_ascii=False, indent=2))

    print("\n=== git status ===")
    print(json.dumps(get("/api/v2/git/status"), ensure_ascii=False, indent=2))

    print("\n=== git commit ===")
    code, body = post("/api/v2/git/commit", {"message": "chore: qa-smoke TASK-023 verify"})
    print("status", code)
    print(json.dumps(body, ensure_ascii=False, indent=2))

    print("\n=== unstick ===")
    code, body = post(
        "/api/v2/tasks/TASK-20260611-023/unstick",
        {"agent_id": "QA-01", "reason": "qa_ui_verify"},
    )
    print("status", code)
    print(json.dumps(body, ensure_ascii=False, indent=2))

    print("\n=== queue snapshot ===")
    q = get("/api/v2/queue")
    print("autoRecovery entries for 023:")
    for a in q.get("autoRecovery", []):
        if "023" in str(a.get("task_id", "")):
            print(json.dumps(a, ensure_ascii=False))


if __name__ == "__main__":
    main()
