import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const root = path.resolve(import.meta.dirname, "../..");
const htmlPath = path.join(root, "codeflowmu-desktop/panel/index.html");
const src = fs.readFileSync(htmlPath, "utf8");

const refs = new Set();
const refPatterns = [
  /\bt\(\s*['"]([^'"]+)['"]/g,
  /data-i18n(?:-[a-z]+)?=["']([^"']+)["']/g,
];
for (const re of refPatterns) {
  let m;
  while ((m = re.exec(src))) refs.add(m[1]);
}

const ignoredDynamicPrefixes = [
  "adm.lc.",
  "adm.scope.",
  "opt.p",
];
const ignoredExact = new Set(["{", "n:0"]);
const refList = [...refs]
  .filter((k) => !ignoredExact.has(k))
  .filter((k) => !ignoredDynamicPrefixes.some((p) => k === p || k.startsWith(p)))
  .sort();

const start = src.indexOf("const LANGS=");
const end = src.indexOf("let lang=", start);
if (start < 0 || end < 0) {
  console.error("Cannot locate LANGS block");
  process.exit(1);
}

const sandbox = {};
vm.runInNewContext(src.slice(start, end).replace("const LANGS=", "globalThis.LANGS="), sandbox);
const zh = sandbox.LANGS?.zh || {};
const en = sandbox.LANGS?.en || {};

const missingZh = refList.filter((k) => !(k in zh));
const missingEn = refList.filter((k) => !(k in en));
const zhOnly = Object.keys(zh).filter((k) => !(k in en)).sort();
const enOnly = Object.keys(en).filter((k) => !(k in zh)).sort();

const report = {
  refs: refList.length,
  zh: Object.keys(zh).length,
  en: Object.keys(en).length,
  missingZh,
  missingEn,
  zhOnly,
  enOnly,
};

if (missingZh.length || missingEn.length || zhOnly.length || enOnly.length) {
  console.error(JSON.stringify(report, null, 2));
  process.exit(1);
}

console.log(JSON.stringify(report, null, 2));
