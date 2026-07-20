'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const htmlPath = path.join(__dirname, '../../codeflowmu-desktop/panel/index.html');
const lines = fs.readFileSync(htmlPath, 'utf8').split(/\r?\n/);
const body = lines.slice(3766, 18113);

let acc = '';
let lastOk = 0;
for (let i = 0; i < body.length; i++) {
  acc += body[i] + '\n';
  try {
    new vm.Script(acc);
    lastOk = i + 1;
  } catch (e) {
    const htmlLine = 3767 + i;
    console.log('FIRST_FAIL at body index', i, 'html line', htmlLine);
    console.log('message:', e.message);
    console.log('last OK through html line', 3766 + lastOk);
    console.log('--- context ---');
    for (let j = Math.max(0, i - 5); j <= Math.min(body.length - 1, i + 5); j++) {
      console.log((3767 + j) + ': ' + body[j].slice(0, 120));
    }
    process.exit(1);
  }
}
console.log('ALL OK lines', body.length);
