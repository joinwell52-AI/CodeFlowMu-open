const fs = require('fs');
const vm = require('vm');
const path = require('path');

const htmlPath = path.join(__dirname, '../../codeflowmu-desktop/panel/index.html');
const html = fs.readFileSync(htmlPath, 'utf8');
const start = html.indexOf('<script>');
if (start < 0) {
  console.error('inline <script> not found');
  process.exit(1);
}
const bodyStart = start + '<script>'.length;
const end = html.toLowerCase().indexOf('</script>', bodyStart);
if (end < 0) {
  console.error('inline </script> not found');
  process.exit(1);
}
const body = html.slice(bodyStart, end);
if (!body.includes('const ICONS')) {
  console.error('extract mismatch');
  process.exit(1);
}
const out = path.join(__dirname, '_inline-check.js');
fs.writeFileSync(out, body, 'utf8');
try {
  new vm.Script(body);
  console.log('SYNTAX OK', body.split('\n').length, 'lines');
} catch (e) {
  console.log('FAIL', e.message);
  process.exit(1);
}
