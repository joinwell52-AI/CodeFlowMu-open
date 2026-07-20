import { toLocalIsoString } from "../_internal/local-iso.ts";
import type { TaskFrontmatterStore } from "./TaskFrontmatterStore.ts";
import {
  isDuplicateTransition,
  transitionCompareFromInput,
} from "./transitionIdempotency.ts";
import type {
  AppendTransitionResult,
  LifecycleWriteOpts,
  TransitionInput,
} from "./types.ts";

export class TransitionRecorder {
  constructor(private store: TaskFrontmatterStore) {}

  async append(
    taskPath: string,
    input: TransitionInput,
    opts?: LifecycleWriteOpts,
  ): Promise<AppendTransitionResult> {
    const { fm, body } = await this.store.read(taskPath);

    const transitions = Array.isArray(fm.transitions) ? fm.transitions : [];
    const last = transitions[transitions.length - 1] as
      | Record<string, unknown>
      | undefined;

    if (
      isDuplicateTransition(last, transitionCompareFromInput(input))
    ) {
      return { appended: false, skipped_duplicate_transition: true };
    }

    const nextFm = {
      ...fm,
      state: input.to,
      lifecycle_path: `fcop/_lifecycle/${input.to}`,
      transitions: [
        ...transitions,
        {
          at: toLocalIsoString(),
          from: input.from,
          to: input.to,
          by: input.by,
          action: input.action,
          ...(input.reason ? { reason: input.reason } : {}),
          ...(input.report ? { report: input.report } : {}),
          ...(input.decision ? { decision: input.decision } : {}),
          ...(input.based_on ? { based_on: input.based_on } : {}),
          ...(input.child_task ? { child_task: input.child_task } : {}),
        },
      ],
    };

    await this.store.write(taskPath, nextFm, body, opts);
    return { appended: true };
  }
}
