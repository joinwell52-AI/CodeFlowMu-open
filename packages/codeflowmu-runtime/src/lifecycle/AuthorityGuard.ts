import {
  resolveArchiveAuthority,
  resolveDoneAuthority,
  resolveDriver,
  resolveReviewer,
} from "./authorityDefaults.ts";
import type { LifecycleAction, TaskFm } from "./types.ts";

export class AuthorityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthorityError";
  }
}

export class AuthorityGuard {
  assert(task: TaskFm, actor: string, action: LifecycleAction): void {
    const a = actor.toUpperCase();

    if (action === "submit_review") {
      const driver = resolveDriver(task);
      if (!driver) {
        throw new AuthorityError(
          "submit_review denied: cannot resolve driver from task routing",
        );
      }
      if (a !== driver) {
        throw new AuthorityError(
          `submit_review denied: actor ${actor} is not driver ${driver}`,
        );
      }
      return;
    }

    if (action === "approve_review") {
      const authority = resolveDoneAuthority(task);
      if (a !== authority) {
        throw new AuthorityError(
          `approve_review denied: actor ${actor} is not done_authority ${authority}`,
        );
      }
      return;
    }

    if (action === "reject_review") {
      const reviewer = resolveReviewer(task);
      const authority = resolveDoneAuthority(task);
      if (a !== reviewer && a !== authority) {
        throw new AuthorityError(
          `reject_review denied: actor ${actor} is not reviewer/done_authority`,
        );
      }
      return;
    }

    if (action === "reopen_task") {
      const reviewer = resolveReviewer(task);
      const authority = resolveDoneAuthority(task);
      if (a !== reviewer && a !== authority && a !== "ADMIN") {
        throw new AuthorityError(
          `reopen_task denied: actor ${actor} is not authorized`,
        );
      }
      return;
    }

    if (action === "archive_task") {
      const authority = resolveArchiveAuthority(task);
      if (a !== authority) {
        throw new AuthorityError(
          `archive_task denied: actor ${actor} is not archive_authority ${authority}`,
        );
      }
    }
  }
}
