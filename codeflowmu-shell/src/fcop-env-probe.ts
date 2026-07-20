/**
 * FCoP / Python runtime probes for Web Panel health + env/check.
 * Uses subprocess (not pythonia) so probes stay lightweight and testable.
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import { checkRoleTemplateHealth, fcopV3Paths } from "./fcop-v3-paths.ts";

const execFileAsync = promisify(execFile);

const PROBE_CACHE_MS = 30_000;

/** CodeFlowMu 示范体要求的 fcop / fcop-mcp Python 包最低版本（lockstep）。 */
export const FCOP_MIN_PACKAGE_VERSION = "3.2.2";

const FCOP_PYTHON_PROBE_SCRIPT = `
import json
import importlib.metadata as md

def pkg_ver(name):
    try:
        return md.version(name)
    except Exception:
        return None

def pick_runtime(*candidates):
    for v in candidates:
        if isinstance(v, str) and v.strip():
            return v.strip()
    return None

fcop_wheel = pkg_ver("fcop")
fcop_mcp_wheel = pkg_ver("fcop-mcp")
fcop_runtime = None
fcop_mcp_runtime = None
fcop_mcp_import_ok = False
try:
    import fcop as _f
    fcop_runtime = getattr(_f, "__version__", None)
except Exception:
    pass
try:
    import fcop_mcp as _m
    fcop_mcp_import_ok = True
    fcop_mcp_runtime = getattr(_m, "__version__", None)
    if not fcop_mcp_runtime:
        try:
            from fcop_mcp._version import __version__ as _mv
            fcop_mcp_runtime = _mv
        except Exception:
            pass
except Exception:
    pass

bundled_rules_version = None
bundled_protocol_version = None
bundled_rules_change_summary = None
bundled_protocol_change_summary = None
try:
    from fcop import rules as _rules
    import re as _re

    def _extract_changes(text, ver):
        if not text or not ver:
            return None
        pattern = r"\\*\\*" + _re.escape(str(ver)) + r" changes.*?(?=\\n\\*\\*[0-9]|\\n---|\\Z)"
        m = _re.search(pattern, text, _re.S | _re.I)
        return m.group(0).strip() if m else None

    bundled_rules_version = _rules.get_rules_version()
    bundled_protocol_version = _rules.get_protocol_version()
    bundled_rules_change_summary = _extract_changes(_rules.get_rules(), bundled_rules_version)
    bundled_protocol_change_summary = _extract_changes(
        _rules.get_protocol_commentary(), bundled_protocol_version
    )
except Exception:
    pass

out = {
    "fcopWheel": fcop_wheel,
    "fcopRuntime": fcop_runtime,
    "fcop": pick_runtime(fcop_runtime, fcop_wheel),
    "fcopMcpWheel": fcop_mcp_wheel,
    "fcopMcpRuntime": fcop_mcp_runtime,
    "fcopMcp": pick_runtime(fcop_mcp_runtime, fcop_mcp_wheel),
    "fcopMcpImportOk": fcop_mcp_import_ok,
    "bundledRulesVersion": bundled_rules_version,
    "bundledProtocolVersion": bundled_protocol_version,
    "bundledRulesChangeSummary": bundled_rules_change_summary,
    "bundledProtocolChangeSummary": bundled_protocol_change_summary,
}
print(json.dumps(out))
`.trim();

export interface FcopPythonProbe {
  /** 运行时 fcop 包版本（__version__ 优先，其次 wheel metadata） */
  fcop: string | null;
  /** 运行时 fcop-mcp 包版本 */
  fcopMcp: string | null;
  fcopMcpImportOk: boolean;
  pythonExecutable: string;
  /** pip/wheel metadata（可能与 __version__ 差一个 patch） */
  fcopWheel?: string | null;
  fcopRuntime?: string | null;
  fcopMcpWheel?: string | null;
  fcopMcpRuntime?: string | null;
  /** fcop 包内 bundled 规则/协议解释版本（≠ 项目本地 .mdc） */
  bundledRulesVersion?: string | null;
  bundledProtocolVersion?: string | null;
  bundledRulesChangeSummary?: string | null;
  bundledProtocolChangeSummary?: string | null;
  error?: string;
}

export interface ProtocolDeployTarget {
  id: string;
  path: string;
  label: string;
  exists: boolean;
  localVersion: string | null;
  bundledVersion: string | null;
  needsUpgrade: boolean;
}

export interface ProtocolUpgradeReport {
  needsUpgrade: boolean;
  summary: string;
  localRulesVersion: string | null;
  localProtocolVersion: string | null;
  bundledRulesVersion: string | null;
  bundledProtocolVersion: string | null;
  deployedVersion: string | null;
  targets: ProtocolDeployTarget[];
  /** bundled 包内该版本的变更摘要（Markdown 正文） */
  bundledRulesChangeSummary: string | null;
  bundledProtocolChangeSummary: string | null;
  adminActions: string[];
}

export interface FcopPackageVersionReport {
  fcop: string | null;
  fcopMcp: string | null;
  fcopWheel: string | null;
  fcopRuntime: string | null;
  fcopMcpWheel: string | null;
  fcopMcpRuntime: string | null;
  pythonExecutable: string;
  requiredMinPackage: string;
  packageVersionOk: boolean;
  fcopBridgeVersion: string | null;
}

export interface FcopJsonMeta {
  protocolVersion: number | string | null;
  mode?: string | null;
  team?: string | null;
  leader?: string | null;
  roles?: string[];
  displayName?: string | null;
}

/** Startup probe from main.ts — used as fallback when subprocess probe fails. */
export interface FcopRuntimeSeed {
  fcopVersion?: string;
  fcopMcpVersion?: string;
  pythonExecutable?: string;
  protocolVersion?: number | string | null;
}

let _probeCache: { key: string; at: number; data: FcopPythonProbe } | null = null;

export function resolvePythonExecutable(preferred?: string): string {
  return preferred ?? process.env["PYTHON_BIN"] ?? "python";
}

/** 解析 semver 三元组；dev/rc 后缀按 0 处理。 */
export function parseSemverTriple(version: string): [number, number, number] | null {
  const m = version.trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function compareSemver(a: string, b: string): number | null {
  const pa = parseSemverTriple(a);
  const pb = parseSemverTriple(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) {
    if (pa[i]! > pb[i]!) return 1;
    if (pa[i]! < pb[i]!) return -1;
  }
  return 0;
}

export function meetsMinPackageVersion(version: string | null | undefined): boolean {
  if (!version) return false;
  const cmp = compareSemver(version, FCOP_MIN_PACKAGE_VERSION);
  return cmp === null ? false : cmp >= 0;
}

/** Windows 上 `python3` 常指向 Store stub；候选顺序：显式 PYTHON_BIN → python → py -3 → python3。 */
export function listPythonProbeCandidates(preferred?: string, seedExe?: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (exe: string | undefined) => {
    const t = exe?.trim();
    if (!t || seen.has(t)) return;
    seen.add(t);
    out.push(t);
  };
  add(preferred);
  add(process.env["PYTHON_BIN"]);
  add(seedExe);
  add("python");
  if (process.platform === "win32") add("py");
  add("python3");
  return out;
}

/**
 * Read codeflowmu-shell semver from package.json.
 * Accepts either the shell package dir (`.../codeflowmu-shell`) or monorepo root.
 */
export function readShellVersion(shellPkgRootOrRepoRoot?: string): string {
  const candidates: string[] = [];
  if (shellPkgRootOrRepoRoot) {
    candidates.push(join(shellPkgRootOrRepoRoot, "package.json"));
    candidates.push(join(shellPkgRootOrRepoRoot, "codeflowmu-shell", "package.json"));
  }
  for (const pkgPath of candidates) {
    if (!existsSync(pkgPath)) continue;
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version?: string };
      if (typeof pkg.version === "string" && pkg.version.trim()) {
        return pkg.version.trim();
      }
    } catch {
      /* try next candidate */
    }
  }
  return "unknown";
}

export function readFcopJsonMeta(projectRoot: string): FcopJsonMeta {
  const fcopJsonPath = join(projectRoot, "fcop", "fcop.json");
  if (!existsSync(fcopJsonPath)) {
    return { protocolVersion: null };
  }
  try {
    const raw = JSON.parse(readFileSync(fcopJsonPath, "utf-8")) as Record<string, unknown>;
    const protocolVersion =
      raw["protocol_version"] ??
      raw["protocolVersion"] ??
      null;
    const rolesRaw = raw["roles"];
    const roles = Array.isArray(rolesRaw)
      ? rolesRaw.map((r) =>
          typeof r === "string" ? r : ((r as { code?: string })?.code ?? ""),
        ).filter(Boolean)
      : undefined;
    return {
      protocolVersion:
        protocolVersion === null || protocolVersion === undefined
          ? null
          : (protocolVersion as number | string),
      mode: typeof raw["mode"] === "string" ? raw["mode"] : null,
      team: typeof raw["team"] === "string" ? raw["team"] : null,
      leader: typeof raw["leader"] === "string" ? raw["leader"] : null,
      roles: roles?.length ? roles : undefined,
      displayName:
        typeof raw["display_name"] === "string"
          ? raw["display_name"]
          : typeof raw["team_name"] === "string"
            ? raw["team_name"]
            : null,
    };
  } catch {
    return { protocolVersion: null };
  }
}

export interface FcopEnvGateResult {
  fcopUninitialized: boolean;
  /** Existing FCoP metadata/layout is incomplete and should re-enter init for repair. */
  fcopRepairRequired: boolean;
  fcopReady: boolean;
  userMessage: string | null;
}

function coerceProtocolVersion(pv: unknown): number | null {
  if (pv == null) return null;
  if (typeof pv === "number" && !Number.isNaN(pv)) return pv;
  const n = Number.parseInt(String(pv), 10);
  return Number.isNaN(n) ? null : n;
}

/** Single gate for env/check + agent wake/chat — 未初始化 vs 预检未通过 分开展示。 */
export function evaluateFcopEnvGate(projectRoot: string): FcopEnvGateResult {
  const fcopJsonPath = join(projectRoot, "fcop", "fcop.json");
  if (!existsSync(fcopJsonPath)) {
    return {
      fcopUninitialized: true,
      fcopRepairRequired: false,
      fcopReady: false,
      userMessage:
        "FCoP 未初始化：请打开「环境预检」完成一键初始化后再启动 Agent。",
    };
  }

  const meta = readFcopJsonMeta(projectRoot);
  const protocolNum = coerceProtocolVersion(meta.protocolVersion);
  const v3 = fcopV3Paths(projectRoot);
  const taskInboxOk = existsSync(v3.inbox);
  const roleHealth = checkRoleTemplateHealth(projectRoot, {
    team: meta.team ?? undefined,
    leader: meta.leader ?? undefined,
    roles: meta.roles,
    mode: meta.mode ?? undefined,
  });

  const fcopReady =
    protocolNum != null &&
    protocolNum >= 3 &&
    taskInboxOk &&
    roleHealth.applicable &&
    roleHealth.ok;

  if (fcopReady) {
    return {
      fcopUninitialized: false,
      fcopRepairRequired: false,
      fcopReady: true,
      userMessage: null,
    };
  }

  const reasons: string[] = [];
  if (protocolNum == null || protocolNum < 3) {
    reasons.push("fcop.json 需声明 protocol_version≥3");
  }
  if (!taskInboxOk) {
    reasons.push("缺少 fcop/_lifecycle/inbox（可重跑一键初始化或预检自动补全）");
  }
  if (roleHealth.applicable && !roleHealth.ok) {
    reasons.push("Rule 4.5 团队角色文档未就绪");
  }

  return {
    fcopUninitialized: false,
    fcopRepairRequired: true,
    fcopReady: false,
    userMessage: `环境预检未通过：${reasons.join("；")}。请停留在「环境预检」完成修复。`,
  };
}

/** Read deployed fcop-rules.mdc version from project (optional). */
export function readFcopRulesVersion(projectRoot: string): string | null {
  const rulesPath = join(projectRoot, ".cursor", "rules", "fcop-rules.mdc");
  if (!existsSync(rulesPath)) return null;
  try {
    const head = readFileSync(rulesPath, "utf-8").slice(0, 800);
    const m = head.match(/fcop_rules_version:\s*([^\s\n]+)/);
    return m?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}

/** Read deployed fcop-protocol.mdc version from project (optional). */
export function readFcopProtocolVersion(projectRoot: string): string | null {
  const protocolPath = join(projectRoot, ".cursor", "rules", "fcop-protocol.mdc");
  if (!existsSync(protocolPath)) return null;
  try {
    const head = readFileSync(protocolPath, "utf-8").slice(0, 800);
    const m = head.match(/fcop_protocol_version:\s*([^\s\n]+)/);
    return m?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}

/** fcop/shared/.deployed_version — last successful deploy_rules() marker. */
export function readDeployedProtocolVersion(projectRoot: string): string | null {
  const markerPath = join(projectRoot, "fcop", "shared", ".deployed_version");
  if (!existsSync(markerPath)) return null;
  try {
    const v = readFileSync(markerPath, "utf-8").trim();
    return v || null;
  } catch {
    return null;
  }
}

function readHostNeutralRuleVersions(projectRoot: string): {
  rules: string | null;
  protocol: string | null;
} {
  const agentsPath = join(projectRoot, "AGENTS.md");
  if (!existsSync(agentsPath)) return { rules: null, protocol: null };
  try {
    const head = readFileSync(agentsPath, "utf-8").slice(0, 1200);
    const m = head.match(
      /Rules version:\s*`([^`]+)`\s*·\s*Protocol commentary version:\s*`([^`]+)`/,
    );
    return {
      rules: m?.[1]?.trim() ?? null,
      protocol: m?.[2]?.trim() ?? null,
    };
  } catch {
    return { rules: null, protocol: null };
  }
}

function isVersionBehind(local: string | null, bundled: string | null): boolean {
  if (!bundled) return false;
  if (!local) return true;
  const cmp = compareSemver(local, bundled);
  return cmp === null ? local !== bundled : cmp < 0;
}

/** 对比项目本地四件套 vs pip 包 bundled 版本（RULE_DOC_DRIFT / redeploy_rules 语义）。 */
export function buildProtocolUpgradeReport(
  projectRoot: string,
  probe: FcopPythonProbe,
): ProtocolUpgradeReport {
  const localRulesVersion = readFcopRulesVersion(projectRoot);
  const localProtocolVersion = readFcopProtocolVersion(projectRoot);
  const hostNeutral = readHostNeutralRuleVersions(projectRoot);
  const deployedVersion = readDeployedProtocolVersion(projectRoot);
  const bundledRulesVersion = probe.bundledRulesVersion ?? probe.fcop ?? null;
  const bundledProtocolVersion =
    probe.bundledProtocolVersion ?? probe.bundledRulesVersion ?? probe.fcop ?? null;

  const targets: ProtocolDeployTarget[] = [
    {
      id: "fcop-rules",
      path: ".cursor/rules/fcop-rules.mdc",
      label: "协议规则 · fcop-rules.mdc",
      exists: existsSync(join(projectRoot, ".cursor", "rules", "fcop-rules.mdc")),
      localVersion: localRulesVersion,
      bundledVersion: bundledRulesVersion,
      needsUpgrade: isVersionBehind(localRulesVersion, bundledRulesVersion),
    },
    {
      id: "fcop-protocol",
      path: ".cursor/rules/fcop-protocol.mdc",
      label: "协议解释 · fcop-protocol.mdc",
      exists: existsSync(join(projectRoot, ".cursor", "rules", "fcop-protocol.mdc")),
      localVersion: localProtocolVersion,
      bundledVersion: bundledProtocolVersion,
      needsUpgrade: isVersionBehind(localProtocolVersion, bundledProtocolVersion),
    },
    {
      id: "agents-md",
      path: "AGENTS.md",
      label: "宿主中立 · AGENTS.md",
      exists: existsSync(join(projectRoot, "AGENTS.md")),
      localVersion: hostNeutral.rules,
      bundledVersion: bundledRulesVersion,
      needsUpgrade: isVersionBehind(hostNeutral.rules, bundledRulesVersion),
    },
    {
      id: "claude-md",
      path: "CLAUDE.md",
      label: "宿主中立 · CLAUDE.md",
      exists: existsSync(join(projectRoot, "CLAUDE.md")),
      localVersion: hostNeutral.rules,
      bundledVersion: bundledRulesVersion,
      needsUpgrade: isVersionBehind(hostNeutral.rules, bundledRulesVersion),
    },
  ];

  const rulesDrift = isVersionBehind(localRulesVersion, bundledRulesVersion);
  const protocolDrift = isVersionBehind(localProtocolVersion, bundledProtocolVersion);
  // `.deployed_version` is written by deploy_role_templates(), not deploy_protocol_rules().
  // Missing marker must not imply drift when the four on-disk targets already match bundled.
  const deployedDrift =
    deployedVersion != null &&
    isVersionBehind(deployedVersion, bundledRulesVersion);
  const needsUpgrade =
    targets.some((t) => t.needsUpgrade) || rulesDrift || protocolDrift || deployedDrift;

  let summary: string;
  if (!bundledRulesVersion && !bundledProtocolVersion) {
    summary = "无法读取 pip 包 bundled 版本（请确认 Python 已安装 fcop）";
  } else if (needsUpgrade) {
    const from = localRulesVersion ?? "缺失";
    const to = bundledRulesVersion ?? bundledProtocolVersion ?? "?";
    summary = `项目协议文件 ${from} → 待同步至 bundled ${to}`;
  } else {
    summary = `协议文件已与 bundled ${bundledRulesVersion ?? bundledProtocolVersion} 对齐`;
  }

  const adminActions: string[] = [];
  if (needsUpgrade) {
    adminActions.push(
      "在 Cursor / MCP 会话中由 ADMIN 执行 redeploy_rules()（或 Python：Project.deploy_protocol_rules(force=True)）",
    );
    adminActions.push(
      "Agent 不得自行调用 redeploy_rules()；升级前旧文件会归档到 .fcop/migrations/<时间戳>/rules/",
    );
    if (!probe.fcop || !meetsMinPackageVersion(probe.fcop)) {
      adminActions.push(
        "若 pip 包版本也落后，可先执行「关于 → 一键升级」或 pip install -U fcop fcop-mcp，再 redeploy_rules()",
      );
    }
  }

  return {
    needsUpgrade,
    summary,
    localRulesVersion,
    localProtocolVersion,
    bundledRulesVersion,
    bundledProtocolVersion,
    deployedVersion,
    targets,
    bundledRulesChangeSummary: probe.bundledRulesChangeSummary ?? null,
    bundledProtocolChangeSummary: probe.bundledProtocolChangeSummary ?? null,
    adminActions,
  };
}

function normalizeProbeResult(exe: string, parsed: Record<string, unknown>): FcopPythonProbe {
  return {
    pythonExecutable: exe,
    fcop: (parsed.fcop as string | null | undefined) ?? null,
    fcopMcp: (parsed.fcopMcp as string | null | undefined) ?? null,
    fcopMcpImportOk: !!parsed.fcopMcpImportOk,
    fcopWheel: (parsed.fcopWheel as string | null | undefined) ?? null,
    fcopRuntime: (parsed.fcopRuntime as string | null | undefined) ?? null,
    fcopMcpWheel: (parsed.fcopMcpWheel as string | null | undefined) ?? null,
    fcopMcpRuntime: (parsed.fcopMcpRuntime as string | null | undefined) ?? null,
    bundledRulesVersion: (parsed.bundledRulesVersion as string | null | undefined) ?? null,
    bundledProtocolVersion: (parsed.bundledProtocolVersion as string | null | undefined) ?? null,
    bundledRulesChangeSummary:
      (parsed.bundledRulesChangeSummary as string | null | undefined) ?? null,
    bundledProtocolChangeSummary:
      (parsed.bundledProtocolChangeSummary as string | null | undefined) ?? null,
  };
}

function probeScore(r: FcopPythonProbe): number {
  let score = 0;
  if (r.fcop) score += 4;
  if (r.fcopMcp) score += 4;
  if (r.fcopMcpImportOk) score += 2;
  if (meetsMinPackageVersion(r.fcop)) score += 8;
  if (meetsMinPackageVersion(r.fcopMcp)) score += 8;
  return score;
}

async function runPythonProbe(exe: string): Promise<FcopPythonProbe> {
  const args =
    exe === "py" && process.platform === "win32"
      ? ["-3", "-c", FCOP_PYTHON_PROBE_SCRIPT]
      : ["-c", FCOP_PYTHON_PROBE_SCRIPT];
  const { stdout } = await execFileAsync(exe, args, { timeout: 12_000 });
  const parsed = JSON.parse(String(stdout).trim()) as Record<string, unknown>;
  return normalizeProbeResult(exe, parsed);
}

/** Probe installed fcop + fcop-mcp Python packages (cached ~30s). */
export async function probeFcopPythonPackages(
  preferredPython?: string,
  seed?: FcopRuntimeSeed,
): Promise<FcopPythonProbe> {
  const candidates = listPythonProbeCandidates(preferredPython, seed?.pythonExecutable);
  const cacheKey = candidates.join("|");
  if (_probeCache && _probeCache.key === cacheKey && Date.now() - _probeCache.at < PROBE_CACHE_MS) {
    return mergeSeed(_probeCache.data, seed);
  }

  const primary = candidates[0] ?? resolvePythonExecutable();
  const base: FcopPythonProbe = {
    fcop: null,
    fcopMcp: null,
    fcopMcpImportOk: false,
    pythonExecutable: primary,
  };

  let best: FcopPythonProbe | null = null;
  let lastError: string | undefined;
  for (const exe of candidates) {
    try {
      const result = await runPythonProbe(exe);
      if (!best || probeScore(result) > probeScore(best)) {
        best = result;
      }
      if (result.fcop && result.fcopMcp && meetsMinPackageVersion(result.fcop)) {
        break;
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }

  const finalResult =
    best ??
    ({
      ...base,
      error: lastError ?? "Python interpreter not found",
    } satisfies FcopPythonProbe);

  _probeCache = { key: cacheKey, at: Date.now(), data: finalResult };
  return mergeSeed(finalResult, seed);
}

function mergeSeed(probe: FcopPythonProbe, seed?: FcopRuntimeSeed): FcopPythonProbe {
  if (!seed) return probe;
  // 仅当 subprocess 完全探测失败时才用 pythonia 启动种子；避免旧 seed 覆盖新 wheel。
  const useSeedFcop = !probe.fcop && !!seed.fcopVersion;
  const useSeedMcp = !probe.fcopMcp && !!seed.fcopMcpVersion;
  return {
    ...probe,
    fcop: useSeedFcop ? seed.fcopVersion! : probe.fcop,
    fcopMcp: useSeedMcp ? seed.fcopMcpVersion! : probe.fcopMcp,
    pythonExecutable: probe.pythonExecutable || seed.pythonExecutable || resolvePythonExecutable(),
  };
}

/** 供 About / health API：分层展示 Python 包 vs 协议 vs 规则，避免混读 2.0.0 哲学纪元。 */
export function buildFcopPackageVersionReport(
  probe: FcopPythonProbe,
  seed?: FcopRuntimeSeed,
): FcopPackageVersionReport {
  const fcopBridgeVersion = seed?.fcopVersion ?? null;
  const fcop = probe.fcop;
  const fcopMcp = probe.fcopMcp;
  return {
    fcop,
    fcopMcp,
    fcopWheel: probe.fcopWheel ?? null,
    fcopRuntime: probe.fcopRuntime ?? null,
    fcopMcpWheel: probe.fcopMcpWheel ?? null,
    fcopMcpRuntime: probe.fcopMcpRuntime ?? null,
    pythonExecutable: probe.pythonExecutable,
    requiredMinPackage: FCOP_MIN_PACKAGE_VERSION,
    packageVersionOk: meetsMinPackageVersion(fcop) && meetsMinPackageVersion(fcopMcp),
    fcopBridgeVersion,
  };
}

/** For tests — reset cached probe results. */
export function __resetFcopProbeCacheForTests(): void {
  _probeCache = null;
}
