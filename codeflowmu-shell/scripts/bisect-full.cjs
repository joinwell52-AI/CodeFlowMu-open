const fs = require("fs");
const vm = require("vm");
const lines = fs
  .readFileSync("d:/codeflowmu/codeflowmu-shell/scripts/_inline-check.js", "utf8")
  .split("\n");

function errAt(n) {
  try {
    new vm.Script(lines.slice(0, n).join("\n"));
    return null;
  } catch (e) {
    return e.message;
  }
}

let firstIdent = null;
for (let n = 100; n <= lines.length; n += 50) {
  const m = errAt(n);
  if (m && m.includes("Unexpected identifier")) {
    firstIdent = n;
    break;
  }
}
if (!firstIdent) {
  console.log("no unexpected identifier in prefix scan");
  process.exit(0);
}
let lo = Math.max(1, firstIdent - 50);
let hi = firstIdent;
while (lo < hi) {
  const mid = Math.floor((lo + hi) / 2);
  const m = errAt(mid);
  if (m && m.includes("Unexpected identifier")) hi = mid;
  else lo = mid + 1;
}
console.log("first line with Unexpected identifier:", lo);
for (let j = lo - 3; j <= lo + 3 && j <= lines.length; j++) {
  console.log(j, lines[j - 1].slice(0, 120));
}
console.log("err", errAt(lo));
