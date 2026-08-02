import type {
  CapabilityRequest,
  OperationApprovalRecord,
  PrepareOperationInput,
} from "./OperationApprovalService.ts";

export const CONTROLLED_EXECUTOR_NAMES = [
  "git.push",
  "filesystem.cleanup",
  "review.policy.save",
  "workspace.fs.write",
  "workspace.fs.mkdir",
  "workspace.fs.copy",
  "workspace.fs.move",
  "workspace.patch.apply",
] as const;

export type ControlledExecutorName = (typeof CONTROLLED_EXECUTOR_NAMES)[number];

export type ControlledExecutionResult = {
  evidence: Array<Record<string, unknown>>;
};

export interface ControlledExecutorAdapter<TInput = unknown> {
  readonly name: ControlledExecutorName;
  prepare(input: TInput): Promise<PrepareOperationInput> | PrepareOperationInput;
  preview(input: TInput): Promise<Record<string, unknown>> | Record<string, unknown>;
  recomputeRequest(record: OperationApprovalRecord): Promise<CapabilityRequest> | CapabilityRequest;
  execute(record: OperationApprovalRecord): Promise<ControlledExecutionResult>;
  recovery(record: OperationApprovalRecord): Promise<Record<string, unknown>> | Record<string, unknown>;
}

export class ControlledExecutorRegistry {
  private readonly adapters = new Map<ControlledExecutorName, ControlledExecutorAdapter>();

  constructor(
    private readonly enabled = process.env["CODEFLOWMU_CONTROLLED_EXECUTORS_ENABLED"] !== "0",
  ) {}

  register<TInput>(adapter: ControlledExecutorAdapter<TInput>): this {
    if (this.adapters.has(adapter.name)) {
      throw new Error(`controlled executor already registered: ${adapter.name}`);
    }
    this.adapters.set(adapter.name, adapter as ControlledExecutorAdapter);
    return this;
  }

  names(): ControlledExecutorName[] {
    return [...this.adapters.keys()].sort();
  }

  canPrepare(name: string): name is ControlledExecutorName {
    return this.enabled && this.adapters.has(name as ControlledExecutorName);
  }

  canExecute(name: string): name is ControlledExecutorName {
    return this.canPrepare(name);
  }

  adapter(name: string): ControlledExecutorAdapter {
    if (!this.enabled) throw new Error(`EXECUTOR_REGISTRY_DISABLED:${name}`);
    const adapter = this.adapters.get(name as ControlledExecutorName);
    if (!adapter) throw new Error(`EXECUTOR_NOT_REGISTERED:${name}`);
    return adapter;
  }

  async prepare(name: string, input: unknown): Promise<PrepareOperationInput> {
    return this.adapter(name).prepare(input);
  }

  async preview(name: string, input: unknown): Promise<Record<string, unknown>> {
    return this.adapter(name).preview(input);
  }

  async recomputeRequest(record: OperationApprovalRecord): Promise<CapabilityRequest> {
    return this.adapter(record.request.action.executor).recomputeRequest(record);
  }

  async execute(record: OperationApprovalRecord): Promise<ControlledExecutionResult> {
    return this.adapter(record.request.action.executor).execute(record);
  }

  async recovery(record: OperationApprovalRecord): Promise<Record<string, unknown>> {
    return this.adapter(record.request.action.executor).recovery(record);
  }
}
