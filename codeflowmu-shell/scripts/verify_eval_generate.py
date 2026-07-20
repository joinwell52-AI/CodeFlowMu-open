#!/usr/bin/env python3
"""Verify generate-eval API for repro tasks 019/020."""
import json
import urllib.error
import urllib.request

BASE = "http://127.0.0.1:18766"
TASKS = ["TASK-20260609-019", "TASK-20260609-020"]


def get_closeout(task_id: str) -> dict:
    url = f"{BASE}/api/v2/admin/task-closeout?task_id={task_id}&ensure_eval=0"
    with urllib.request.urlopen(url, timeout=15) as r:
        return json.loads(r.read().decode())


def post_generate(task_id: str) -> dict:
    req = urllib.request.Request(
        f"{BASE}/api/v2/admin/task-closeout/generate-eval",
        data=json.dumps({"task_id": task_id}).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode())


def main() -> None:
    for tid in TASKS:
        print(f"\n=== {tid} ===")
        try:
            before = get_closeout(tid)
        except Exception as e:
            print("GET before failed:", e)
            continue
        hint_before = before.get("admin_closeout_hint", {})
        print("hint before:", hint_before)
        try:
            gen = post_generate(tid)
        except urllib.error.HTTPError as e:
            print("POST failed:", e.read().decode())
            continue
        except Exception as e:
            print("POST failed:", e)
            continue
        hint_after = gen.get("admin_closeout_hint", {})
        print("result:", gen.get("result"))
        print("hint after:", hint_after)
        print("has eval:", bool(gen.get("closeout", {}).get("eval_observation")))


if __name__ == "__main__":
    main()
