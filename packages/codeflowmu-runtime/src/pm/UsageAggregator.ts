import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface UsageAggregateSlice {
  cost: number;
  runs: number;
  input_tokens: number;
  output_tokens: number;
}

export interface ThreadUsageSummary {
  total_cost_usd: number;
  total_runs: number;
  total_input_tokens: number;
  total_output_tokens: number;
  by_task: Record<string, UsageAggregateSlice>;
  by_agent: Record<string, UsageAggregateSlice>;
  days_scanned: string[];
}

function emptySlice(): UsageAggregateSlice {
  return { cost: 0, runs: 0, input_tokens: 0, output_tokens: 0 };
}

function bump(
  map: Record<string, UsageAggregateSlice>,
  key: string,
  cost: number,
  inTok: number,
  outTok: number,
): void {
  const k = key.trim();
  if (!k) return;
  if (!map[k]) map[k] = emptySlice();
  const s = map[k]!;
  s.cost += cost;
  s.runs += 1;
  s.input_tokens += inTok;
  s.output_tokens += outTok;
}

/**
 * Scan fcop/logs/usage/usage-*.jsonl and aggregate rows matching thread_key
 * and/or any of the given task_ids.
 */
export function aggregateUsageForThread(
  projectRoot: string,
  opts: { thread_key: string; task_ids: string[]; maxDays?: number },
): ThreadUsageSummary {
  const usageDir = join(projectRoot, "fcop", "logs", "usage");
  const taskIdSet = new Set(opts.task_ids.map((id) => id.replace(/\.md$/i, "").trim()));
  const threadKey = opts.thread_key.trim();
  const maxDays = opts.maxDays ?? 14;

  const result: ThreadUsageSummary = {
    total_cost_usd: 0,
    total_runs: 0,
    total_input_tokens: 0,
    total_output_tokens: 0,
    by_task: {},
    by_agent: {},
    days_scanned: [],
  };

  if (!existsSync(usageDir)) return result;

  let files: string[];
  try {
    files = readdirSync(usageDir)
      .filter((f) => /^usage-\d{8}\.jsonl$/i.test(f))
      .sort()
      .slice(-maxDays);
  } catch {
    return result;
  }

  for (const file of files) {
    const day = file.replace(/^usage-|\.jsonl$/gi, "");
    result.days_scanned.push(day);
    const filePath = join(usageDir, file);
    let lines: string[];
    try {
      lines = readFileSync(filePath, "utf-8").split("\n").filter(Boolean);
    } catch {
      continue;
    }
    for (const line of lines) {
      let rec: {
        agent_id?: string;
        task_id?: string;
        thread_key?: string;
        payload?: {
          raw?: {
            total_cost_usd?: number;
            usage?: { input_tokens?: number; output_tokens?: number };
            task_id?: string | null;
            thread_key?: string | null;
          };
        };
      };
      try {
        rec = JSON.parse(line) as typeof rec;
      } catch {
        continue;
      }
      const raw = rec.payload?.raw;
      const recTask = String(rec.task_id ?? raw?.task_id ?? "").replace(/\.md$/i, "").trim();
      const recThread = String(rec.thread_key ?? raw?.thread_key ?? "").trim();
      const matchesThread = threadKey && recThread === threadKey;
      const matchesTask = recTask && taskIdSet.has(recTask);
      if (!matchesThread && !matchesTask) continue;

      const cost = Number(raw?.total_cost_usd ?? 0);
      const inTok = Number(raw?.usage?.input_tokens ?? 0);
      const outTok = Number(raw?.usage?.output_tokens ?? 0);
      result.total_cost_usd += cost;
      result.total_runs += 1;
      result.total_input_tokens += inTok;
      result.total_output_tokens += outTok;
      if (recTask) bump(result.by_task, recTask, cost, inTok, outTok);
      const agent = String(rec.agent_id ?? "").trim();
      if (agent) bump(result.by_agent, agent, cost, inTok, outTok);
    }
  }

  return result;
}
