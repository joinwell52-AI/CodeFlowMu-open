import {
  MOBILE_ACTIVITY_GLOBAL_CAP,
  MOBILE_ACTIVITY_TASK_CAP,
  OperationCompressor,
} from "./operationCompressor.ts";

const stores = new Map<string, OperationCompressor>();

export function getMobileEventStore(projectRoot: string): OperationCompressor {
  const key = projectRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  let store = stores.get(key);
  if (!store) {
    store = new OperationCompressor({
      globalCap: MOBILE_ACTIVITY_GLOBAL_CAP,
      taskCap: MOBILE_ACTIVITY_TASK_CAP,
    });
    stores.set(key, store);
  }
  return store;
}

export function resetMobileEventStoreForTests(projectRoot?: string): void {
  if (projectRoot) {
    const key = projectRoot.replace(/\\/g, "/").replace(/\/+$/, "");
    stores.delete(key);
    return;
  }
  stores.clear();
}
