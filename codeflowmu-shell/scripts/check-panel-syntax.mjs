import fs from 'fs';
import vm from 'vm';

const files = [
  'd:/codeflowmu/codeflowmu-desktop/panel/index.html',
  'd:/codeflowmu/codeflowmu-desktop/panel/home-reactor.js',
  'd:/codeflowmu/codeflowmu-desktop/panel/log-center.js',
  'd:/codeflowmu/codeflowmu-desktop/panel/team-pm-panel.js',
];

for (const f of files) {
  const h = fs.readFileSync(f, 'utf8');
  if (f.endsWith('.html')) {
    const re = /<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi;
    let m;
    let i = 0;
    while ((m = re.exec(h))) {
      if (/src=/i.test(m[0])) continue;
      i++;
      try {
        new vm.Script(m[1], { filename: `${f}#inline-${i}` });
        console.log('OK', `${f}#inline-${i}`);
      } catch (e) {
        console.log('FAIL', `${f}#inline-${i}`, e.message);
        const line = e.stack?.split('\n')[0];
        console.log(line);
      }
    }
  } else {
    try {
      new vm.Script(h, { filename: f });
      console.log('OK', f);
    } catch (e) {
      console.log('FAIL', f, e.message);
    }
  }
}
