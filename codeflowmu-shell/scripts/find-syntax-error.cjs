const fs = require('fs');
const vm = require('vm');
const path = require('path');

const file = path.join(__dirname, '_inline-check.js');
const lines = fs.readFileSync(file, 'utf8').split('\n');

function errAt(n) {
  try {
    new vm.Script(lines.slice(0, n).join('\n'));
    return null;
  } catch (e) {
    return e.message;
  }
}

// Find first line where prefix fails
let lo = 1;
let hi = lines.length;
let lastOk = 0;
while (lo <= hi) {
  const mid = Math.floor((lo + hi) / 2);
  const m = errAt(mid);
  if (m) {
    hi = mid - 1;
  } else {
    lastOk = mid;
    lo = mid + 1;
  }
}
const failLine = lastOk + 1;
console.log('last OK line:', lastOk, 'first fail at:', failLine);
console.log('error:', errAt(failLine));
for (let j = Math.max(1, failLine - 5); j <= Math.min(lines.length, failLine + 5); j++) {
  console.log(String(j).padStart(6), lines[j - 1].slice(0, 140));
}
