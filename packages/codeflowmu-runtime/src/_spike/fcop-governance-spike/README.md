# fcop-mcp 1.2.0 governance spike (TASK-022)

**Goal**: validate whether codeflowmu can reuse `fcop_mcp.governance` (via pythonia)
to replace the proposed P3.5 self-built Capability interception layer.

**Status**: read-only spike —**does NOT touch v0.3.0-alpha business code**.
This entire directory is `.gitignore`d by convention (sibling `fcop-pythonia-spike/`
applies same rule). Will not be committed.

## Files

| File | Purpose |
|---|---|
| `README.md` | This file. |
| `spike-s1-pythonia-import.ts` | S1 —TS/Node side via `pythonia` import the 5 exports. |
| `spike-s2-s3-s4-s5.py` | S2/S3/S4/S5 —direct Python verification (faster than going through pythonia). |
| `spike-s5-runtime-smoke.ps1` | S5 —runtime npm test + codeflowmu-shell smoke (real fcop, with fcop-mcp 1.2.0 installed in the same Python 3.12 venv). |
| `decision-matrix.md` | Final spike output —P3.5 self-built vs fcop-mcp 1.2.0 integration. |
| `skill-meta.ts.draft` | O2 (optional) —TS mirror of `SkillMeta` dataclass for future P4.5 sprint. |

## Environment guarantees

- `FCOP_EVENT_LOG` is always set to `$env:TEMP/fcop-spike-events/<scenario>.jsonl`.
- `cwd` writes never trigger —emit_event ONLY writes to redirected env path.
- No package.json / .env / production code is modified.
- All spike processes are short-lived (no long-running shells).

## Result summary

See `decision-matrix.md` (Day 6 EOD).

