/**
 * PanelEventBridge — forwards runtime governance facts to the host UI sink.
 *
 * CodeFlowMu shell wires `setSink((type, payload) => sseEmit(type, payload))`
 * so LifecycleGovernor / ReportGate / TaskDispatcher / ReportWatcher events
 * land in doorbell buffer + runtime-events.jsonl + log center.
 */

export type PanelEventSink = (
  type: string,
  payload: Record<string, unknown>,
) => void;

/** Panel-visible event types (host may mirror into JSONL / log-center). */
export const PANEL_EVENT_TYPES = [
  "codeflowmu.task_dispatched",
  "codeflowmu.report_detected",
  "codeflowmu.lifecycle.inbox_to_active",
  "codeflowmu.lifecycle.task_to_review",
  "codeflowmu.lifecycle.root_review_blocked",
  "codeflowmu.lifecycle.review_to_done",
  "codeflowmu.lifecycle.done_to_archive",
  "codeflowmu.lifecycle.review_to_active",
  "codeflowmu.lifecycle.done_to_active",
  "codeflowmu.lifecycle.pending_pm_review",
  "codeflowmu.report_gate.missing_report",
  "codeflowmu.report_gate.waiting_report",
  "codeflowmu.sdk.cooldown",
  "codeflowmu.downstream_auto_nudge",
] as const;

export type PanelEventType = (typeof PANEL_EVENT_TYPES)[number];

export class PanelEventBridge {
  #sink: PanelEventSink | null = null;

  setSink(sink: PanelEventSink | null): void {
    this.#sink = sink;
  }

  emit(type: string, payload: Record<string, unknown>): void {
    this.#sink?.(type, payload);
  }
}
