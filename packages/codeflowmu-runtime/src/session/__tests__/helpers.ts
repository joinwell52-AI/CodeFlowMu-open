/**
 * Test helpers for the Session-layer tests.
 *
 * Mirrors the structure of `registry/__tests__/helpers.ts` (decision-D
 * style: scope tests to `os.tmpdir()` so production state is never touched).
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JsonFileStore } from "../../registry/PersistentStore.ts";
import { SessionStore } from "../SessionStore.ts";
import { TranscriptWriter } from "../TranscriptWriter.ts";

export async function withTempSessionDir<T>(
  fn: (ctx: {
    sessionStore: SessionStore;
    transcriptWriter: TranscriptWriter;
    sessionsDir: string;
    transcriptsDir: string;
    agentsPath: string;
    agentStore: JsonFileStore;
    rootDir: string;
  }) => Promise<T>,
): Promise<T> {
  const rootDir = await mkdtemp(join(tmpdir(), "codeflowmu-session-test-"));
  const sessionsDir = join(rootDir, "sessions");
  const transcriptsDir = join(rootDir, "transcripts");
  const agentsPath = join(rootDir, "agents.json");
  const sessionStore = new SessionStore({ dir: sessionsDir });
  const transcriptWriter = new TranscriptWriter({ dir: transcriptsDir });
  const agentStore = new JsonFileStore({ path: agentsPath });
  try {
    return await fn({
      sessionStore,
      transcriptWriter,
      sessionsDir,
      transcriptsDir,
      agentsPath,
      agentStore,
      rootDir,
    });
  } finally {
    await transcriptWriter.closeAll().catch(() => undefined);
    await rm(rootDir, { recursive: true, force: true });
  }
}

