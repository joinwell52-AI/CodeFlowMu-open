/**
 * Open edition startup shim.
 *
 * pythonia defaults to "python3", which is usually absent on Windows.
 * Set an absolute platform-appropriate default before importing main.ts,
 * while preserving an explicit PYTHON_BIN from the user or .env.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { startOpenInstallIntegrityGuard } from './open-install-integrity.ts';

function findProjectRoot() {
  let dir = process.cwd();
  for (let i = 0; i < 5; i++) {
    if (existsSync(join(dir, 'codeflowmu.team.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

function firstExisting(paths: Array<string | undefined>): string | undefined {
  return paths.find((candidate) => candidate && existsSync(candidate));
}

function resolveWindowsPython() {
  const projectRoot = findProjectRoot();
  const venvPython = firstExisting([
    join(projectRoot, '.venv', 'Scripts', 'python.exe'),
    join(projectRoot, 'venv', 'Scripts', 'python.exe')
  ]);
  if (venvPython) return venvPython;

  try {
    const out = execFileSync('where.exe', ['python'], { encoding: 'utf8' });
    const candidates = out
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !line.toLowerCase().includes('\\windowsapps\\'));
    return firstExisting(candidates);
  } catch {
    return undefined;
  }
}

if (!process.env.PYTHON_BIN && process.platform === 'win32') {
  const pythonBin = resolveWindowsPython();
  if (pythonBin) process.env.PYTHON_BIN = pythonBin;
}

const openHostRoot = findProjectRoot();
const projectsRegistry = join(openHostRoot, '.codeflowmu', 'projects-registry.json');
const preferredDefaultProjectRoot = join(openHostRoot, 'projects', 'newproject');
const legacyDefaultProjectRoot = join(openHostRoot, 'workspace', 'newproject');
let registeredActiveProjectRoot;
if (existsSync(projectsRegistry)) {
  try {
    const parsed = JSON.parse(readFileSync(projectsRegistry, 'utf8'));
    const active = Array.isArray(parsed.projects)
      ? parsed.projects.find(
          (project: { id?: string; root?: string }) => project?.id === parsed.activeProjectId,
        )
      : undefined;
    if (active?.root && existsSync(active.root)) registeredActiveProjectRoot = active.root;
  } catch {
    // Invalid registries are never overwritten automatically.
  }
}
const defaultProjectRoot = registeredActiveProjectRoot ??
  (!existsSync(projectsRegistry) && existsSync(legacyDefaultProjectRoot)
    ? legacyDefaultProjectRoot
    : preferredDefaultProjectRoot);
const defaultProjectTemplate = join(openHostRoot, 'templates', 'default-project');
if (!registeredActiveProjectRoot && !existsSync(join(defaultProjectRoot, 'fcop', 'fcop.json'))) {
  mkdirSync(defaultProjectRoot, { recursive: true });
  if (existsSync(defaultProjectTemplate)) {
    cpSync(defaultProjectTemplate, defaultProjectRoot, {
      recursive: true,
      force: false,
      errorOnExist: false,
    });
  }
}
for (const skillName of ['windows-use', 'browser-use']) {
  const source = join(openHostRoot, 'skills', skillName);
  const destination = join(defaultProjectRoot, 'skills', skillName);
  if (existsSync(source) && !existsSync(destination)) {
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(source, destination, { recursive: true, force: false, errorOnExist: false });
  }
}
const publicSkillsDocsSource = join(openHostRoot, 'docs', 'skills');
const publicSkillsDocsDestination = join(defaultProjectRoot, 'docs', 'skills');
if (existsSync(publicSkillsDocsSource) && !existsSync(publicSkillsDocsDestination)) {
  mkdirSync(dirname(publicSkillsDocsDestination), { recursive: true });
  cpSync(publicSkillsDocsSource, publicSkillsDocsDestination, {
    recursive: true,
    force: false,
    errorOnExist: false,
  });
}
const agentSkillsSource = join(publicSkillsDocsDestination, 'agent-skills.manifest.json');
const agentSkillsProjection = join(defaultProjectRoot, '.codeflowmu', 'agent-skills.manifest.json');
if (existsSync(agentSkillsSource) && !existsSync(agentSkillsProjection)) {
  mkdirSync(dirname(agentSkillsProjection), { recursive: true });
  cpSync(agentSkillsSource, agentSkillsProjection, { force: false, errorOnExist: false });
}
if (!existsSync(projectsRegistry)) {
  mkdirSync(dirname(projectsRegistry), { recursive: true });
  writeFileSync(
    projectsRegistry,
    JSON.stringify({
      version: 1,
      activeProjectId: 'open-default-newproject',
      projects: [{
        id: 'open-default-newproject',
        name: 'newproject',
        root: defaultProjectRoot,
      }],
    }, null, 2) + '\n',
    'utf8',
  );
}
const activeProjectRoot = registeredActiveProjectRoot ?? defaultProjectRoot;
process.env.CODEFLOW_PROVIDER = 'cursor';
process.env.CODEFLOW_OPEN_EDITION = '1';
process.env.CODEFLOW_OPEN_HOST_ROOT = openHostRoot;
process.env.CODEFLOW_OPEN_PROTECTED_ROOTS = openHostRoot;
process.env.CODEFLOW_PROJECTS_REGISTRY = projectsRegistry;
process.env.CODEFLOW_OPEN_DEFAULT_PROJECT_ROOT = activeProjectRoot;
process.env.CODEFLOW_DATA_DIR = join(
  activeProjectRoot,
  '.codeflowmu',
  'runtime',
);
process.env.CODEFLOW_CURSOR_USAGE_SYNC = '0';

const installIntegrityGuard = await startOpenInstallIntegrityGuard(openHostRoot);
process.stderr.write(
  `[open-integrity] protected baseline: ${installIntegrityGuard.baselineFileCount} files\n`,
);

await import('./main.ts');
