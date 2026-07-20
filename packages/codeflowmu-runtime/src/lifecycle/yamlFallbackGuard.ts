/**
 * When fcop client is unavailable, CodeFlowMu still owns the local YAML
 * lifecycle kernel. Fallback mode means "no Python fcop bridge", not
 * "do not move _lifecycle files".
 */

export type LifecycleWriteContext = "automatic" | "admin_manual";

export class YamlFallbackWriteBlockedError extends Error {
  readonly code = "yaml_fallback_write_blocked" as const;

  constructor(detail: string) {
    super(`yaml fallback: automatic lifecycle write blocked (${detail})`);
    this.name = "YamlFallbackWriteBlockedError";
  }
}

export function isYamlFallbackAutomaticWriteBlocked(
  yamlFallbackMode: boolean,
  context: LifecycleWriteContext,
): boolean {
  void yamlFallbackMode;
  void context;
  return false;
}

export function assertYamlFallbackWriteAllowed(
  yamlFallbackMode: boolean,
  context: LifecycleWriteContext,
  operation: string,
): void {
  if (isYamlFallbackAutomaticWriteBlocked(yamlFallbackMode, context)) {
    throw new YamlFallbackWriteBlockedError(operation);
  }
}
