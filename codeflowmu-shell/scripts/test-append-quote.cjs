'use strict';
const fs = require('fs');
const vm = require('vm');
const p = require('path').join(__dirname, '_inline-check.js');
let s = fs.readFileSync(p, 'utf8');
for (const suffix of ["\n'", "\n''", "\n`", "\n}", "\n});", "\n');"]) {
  try {
    new vm.Script(s + suffix);
    console.log('OK suffix:', JSON.stringify(suffix));
  } catch (e) {
    console.log('FAIL suffix:', JSON.stringify(suffix), e.message.slice(0, 80));
  }
}
