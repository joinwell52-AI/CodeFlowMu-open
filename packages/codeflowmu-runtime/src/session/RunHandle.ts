/**
 * RunHandle — runtime-only abstraction for a single in-flight Run.
 *
 * The persisted form of a Run is `SessionRun` (in `@codeflowmu/protocol`),
 * which lives inside `SessionRecord.protocol.runs[]`. This file only
 * re-exports the runtime-private interface defined alongside the rest of
 * the runtime types.
 *
 * Why re-export instead of redefine? — because S2 deliberately keeps all
 * runtime types in one file (`types/state.ts`) so the "this is what is
 * NOT in the FCoP schema" boundary is visible at a glance. Splitting the
 * type across files would dilute that boundary.
 *
 * Reference: design doc `docs/design/codeflowmu-v2-on-fcop-sdk.md` §3.5
 * (Session Schema) for the persisted SessionRun shape.
 */

export type { RunHandle } from "../types/state.ts";

