'use strict';
const fs = require('fs');
const vm = require('vm');
const p = require('path').join(__dirname, '_inline-check.js');
const s = fs.readFileSync(p, 'utf8');
for (let n = 0; n <= 12; n++) {
  const suffix = '\n' + '}'.repeat(n);
  try {
    new vm.Script(s + suffix);
    console.log('OK with', n, 'closing braces');
  } catch (e) {
    console.log('FAIL', n, 'braces:', e.message.slice(0, 60));
  }
}
