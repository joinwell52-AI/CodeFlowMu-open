'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const htmlPath = path.join(__dirname, '../../codeflowmu-desktop/panel/index.html');
const allLines = fs.readFileSync(htmlPath, 'utf8').split(/\r?\n/);
const start = 3766;
const end = 18113;

function tryParse(lastLineInclusive) {
  const body = allLines.slice(start, lastLineInclusive);
  const src = body.join('\n') + '\n}';
  try {
    new vm.Script(src, { filename: 'bisect.js' });
    return true;
  } catch {
    return false;
  }
}

let lo = start + 1;
let hi = end;
let firstOk = end;
while (lo <= hi) {
  const mid = Math.floor((lo + hi) / 2);
  if (tryParse(mid)) {
    firstOk = mid;
    hi = mid - 1;
  } else {
    lo = mid + 1;
  }
}

console.log('First line (1-based html) where prefix+} parses OK:', firstOk);
console.log('Context:');
for (let L = firstOk - 3; L <= firstOk + 2 && L <= end; L++) {
  if (L < start + 1) continue;
  console.log(L + ':', allLines[L - 1].slice(0, 120));
}
