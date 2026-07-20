/**
 * Agent Playbook Skill manifest: stable source vs local/runtime projection.
 *
 * - `docs/skills/agent-skills.manifest.json` — source-of-truth (in repo)
 * - `.codeflowmu/agent-skills.manifest.json` — runtime projection (may be deleted with `.codeflowmu/`)
 */
import { access, copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

export const AGENT_SKILLS_MANIFEST_SOURCE_REL = "docs/skills/agent-skills.manifest.json";
export const AGENT_SKILLS_MANIFEST_PROJECTION_REL =
  ".codeflowmu/agent-skills.manifest.json";

export function agentSkillsManifestSourcePath(projectRoot: string): string {
  return join(projectRoot, AGENT_SKILLS_MANIFEST_SOURCE_REL);
}

export function agentSkillsManifestProjectionPath(projectRoot: string): string {
  return join(projectRoot, AGENT_SKILLS_MANIFEST_PROJECTION_REL);
}

export interface PlantAgentSkillsManifestResult {
  planted: boolean;
  path: string;
  sourcePath: string;
  /** True when projection was missing but docs/skills source file does not exist. */
  sourceMissing: boolean;
}

export interface PlantAgentSkillsManifestOptions {
  /**
   * Optional CodeFlowMu host root used as the source of the stable
   * docs/skills manifest when planting into an external product project.
   */
  sourceRoot?: string;
}

/**
 * If `.codeflowmu/agent-skills.manifest.json` is missing, copy from
 * `docs/skills/agent-skills.manifest.json` (copy-if-missing only; never overwrites).
 */
export async function plantAgentSkillsManifestIfMissing(
  projectRoot: string,
  opts: PlantAgentSkillsManifestOptions = {},
): Promise<PlantAgentSkillsManifestResult> {
  const path = agentSkillsManifestProjectionPath(projectRoot);
  const sourcePath = agentSkillsManifestSourcePath(opts.sourceRoot ?? projectRoot);
  try {
    await access(path);
    return { planted: false, path, sourcePath, sourceMissing: false };
  } catch {
    try {
      await access(sourcePath);
    } catch {
      return { planted: false, path, sourcePath, sourceMissing: true };
    }
    await mkdir(dirname(path), { recursive: true });
    await copyFile(sourcePath, path);
    return { planted: true, path, sourcePath, sourceMissing: false };
  }
}
