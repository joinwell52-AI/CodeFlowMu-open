import type {
  AgentCreateSpec,
  AgentSdkAdapter,
} from "./AgentSdkAdapter.ts";

const DEFAULT_VISIBILITY_BACKOFF_MS = [100, 250, 500, 1_000, 2_000, 4_000] as const;

function errorText(err: unknown, seen = new Set<unknown>()): string {
  if (err == null || seen.has(err)) return "";
  seen.add(err);
  if (err instanceof Error) {
    const rec = err as Error & { code?: unknown; cause?: unknown };
    return [err.name, err.message, rec.code, errorText(rec.cause, seen)]
      .filter(Boolean)
      .join(" ");
  }
  if (typeof err === "object") {
    const rec = err as Record<string, unknown>;
    return [rec["name"], rec["message"], rec["code"], errorText(rec["cause"], seen)]
      .filter(Boolean)
      .join(" ");
  }
  return String(err);
}

export function isAgentNotFoundLike(err: unknown): boolean {
  const text = errorText(err).toLowerCase();
  return (
    text.includes("agent_not_found") ||
    text.includes("agent not found") ||
    text.includes("agent was not found") ||
    text.includes("no such agent") ||
    text.includes("does not exist") ||
    text.includes("not in the sdk's known set")
  );
}

export interface VerifiedSdkBindingOptions {
  visibilityBackoffMs?: readonly number[];
}

/**
 * Create an SDK agent, then prove that the returned id is resumable before
 * callers make it durable. Cursor can briefly return an id before it becomes
 * visible to Agent.resume(), so agent_not_found is retried in-place.
 */
export async function createVerifiedSdkBinding(
  sdk: AgentSdkAdapter,
  spec: AgentCreateSpec,
  opts: VerifiedSdkBindingOptions = {},
): Promise<string> {
  const { sdk_agent_id: sdkAgentId } = await sdk.create(spec);
  const backoff = opts.visibilityBackoffMs ?? DEFAULT_VISIBILITY_BACKOFF_MS;

  for (let attempt = 0; ; attempt += 1) {
    try {
      await sdk.resume(sdkAgentId);
      return sdkAgentId;
    } catch (err) {
      if (!isAgentNotFoundLike(err) || attempt >= backoff.length) {
        throw new Error(
          `SDK created sdk_agent_id="${sdkAgentId}" but resume verification failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
          { cause: err },
        );
      }
      await new Promise((resolve) => setTimeout(resolve, backoff[attempt]!));
    }
  }
}
