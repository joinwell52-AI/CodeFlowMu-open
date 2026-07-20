'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const allLines = fs.readFileSync(path.join(__dirname, '../../codeflowmu-desktop/panel/index.html'), 'utf8').split(/\r?\n/);
const start = 3766;
const end = 18113;

function status(lastLine) {
  const body = allLines.slice(start, lastLine);
  const src = body.join('\n');
  try {
    new vm.Script(src);
    return 'ok-no-brace';
  } catch (e1) {
    try {
      new vm.Script(src + '\n}');
      return 'ok-with-brace';
    } catch (e2) {
      return 'fail:' + (e2.message || '').slice(0, 40);
    }
  }
}

let firstNeedBrace = null;
for (let L = 15391; L <= end; L++) {
  const st = status(L);
  if (st === 'ok-with-brace' && firstNeedBrace === null) {
    // still only needs one brace at end when truncated here - not what we want
  }
  if (st === 'ok-no-brace') {
    console.log('First line that is complete without extra brace:', L);
    break;
  }
  if (L % 500 === 0 || L > end - 5) console.log(L, st);
}

// Find first line in range where full-to-L still needs brace at EOF
for (let L = 15391; L <= end; L++) {
  const st = status(L);
  if (st === 'ok-with-brace') {
    console.log('Still needs trailing } through line', L);
  } else if (st.startsWith('fail')) {
    console.log('Broken even with } at line', L, st);
    console.log('Line:', allLines[L - 1].slice(0, 100));
    break;
  }
}
