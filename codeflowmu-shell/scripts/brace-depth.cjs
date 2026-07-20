'use strict';
const fs = require('fs');
const path = require('path');

const htmlPath = path.join(__dirname, '../../codeflowmu-desktop/panel/index.html');
const allLines = fs.readFileSync(htmlPath, 'utf8').split(/\r?\n/);
const startHtmlLine = 3767;
const body = allLines.slice(3766, 18113);
const src = body.join('\n');

let i = 0;
let state = 'code';
let tplDepth = 0;
let brace = 0;
let line = 1;
let col = 0;
const opens = [];

function pos() {
  return { line, col, htmlLine: startHtmlLine + line - 1 };
}
function bump(ch) {
  if (ch === '\n') {
    line++;
    col = 0;
  } else col++;
}

while (i < src.length) {
  const ch = src[i];
  const next = src[i + 1];

  if (state === 'linecomment') {
    if (ch === '\n') state = 'code';
    i++;
    bump(ch);
    continue;
  }
  if (state === 'blockcomment') {
    if (ch === '*' && next === '/') {
      i += 2;
      state = 'code';
      continue;
    }
    i++;
    bump(ch);
    continue;
  }
  if (state === 'squote' || state === 'dquote') {
    const q = state === 'squote' ? "'" : '"';
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === q) state = 'code';
    i++;
    bump(ch);
    continue;
  }
  if (state === 'tpl') {
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '`') {
      tplDepth--;
      if (tplDepth <= 0) {
        tplDepth = 0;
        state = 'code';
      }
      i++;
      bump(ch);
      continue;
    }
    if (ch === '$' && next === '{' && tplDepth > 0) {
      brace++;
      opens.push({ ...pos(), kind: 'tpl-expr' });
      i += 2;
      continue;
    }
    i++;
    bump(ch);
    continue;
  }

  if (ch === '/' && next === '/') {
    state = 'linecomment';
    i += 2;
    continue;
  }
  if (ch === '/' && next === '*') {
    state = 'blockcomment';
    i += 2;
    continue;
  }
  if (ch === "'") {
    state = 'squote';
    i++;
    bump(ch);
    continue;
  }
  if (ch === '"') {
    state = 'dquote';
    i++;
    bump(ch);
    continue;
  }
  if (ch === '`') {
    tplDepth++;
    state = 'tpl';
    i++;
    bump(ch);
    continue;
  }
  if (ch === '{') {
    brace++;
    opens.push({ ...pos(), kind: '{' });
  } else if (ch === '}') {
    brace--;
    if (opens.length) opens.pop();
  }
  i++;
  bump(ch);
}

console.log('EOF brace depth:', brace, 'state:', state, 'tplDepth:', tplDepth);
console.log('Unclosed opens (last 8):');
for (const o of opens.slice(-8)) {
  const idx = o.htmlLine - startHtmlLine;
  console.log(o.htmlLine + ':' + o.col, o.kind, body[idx]?.slice(0, 100));
}
