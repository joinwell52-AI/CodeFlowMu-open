/**
 * KeyedMutex — per-key async mutual exclusion.
 *
 * Same key serializes `run()` calls; different keys run concurrently.
 */

export class KeyedMutex {
  readonly #tails = new Map<string, Promise<void>>();

  /** Run `fn` exclusively for `key`. */
  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.#tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = prev.then(() => gate);
    this.#tails.set(key, tail);

    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.#tails.get(key) === tail) {
        this.#tails.delete(key);
      }
    }
  }
}

/** Process-wide mutex for agents.json and other singleton paths. */
export const globalFileWriteMutex = new KeyedMutex();

/** One SDK send/startSession chain per sdk_agent_id (prevents SQLITE UNIQUE on runs). */
export const agentSdkMutex = new KeyedMutex();

/** One lifecycle transition per task_id at a time. */
export const taskLifecycleMutex = new KeyedMutex();

/** One PM wake / startSession chain per agent_id (prevents duplicate concurrent wakes). */
export const agentWakeMutex = new KeyedMutex();
