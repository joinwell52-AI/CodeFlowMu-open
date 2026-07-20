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
let line = 1;
let col = 0;
let openSquote = null;
let openDquote = null;
let openTpl = null;
let tplDepth = 0;

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
  if (state === 'squote') {
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === "'") {
      state = 'code';
      openSquote = null;
    }
    i++;
    bump(ch);
    continue;
  }
  if (state === 'dquote') {
    if (ch === '\\') {
      i += 2;
      continue;
    }
    if (ch === '"') {
      state = 'code';
      openDquote = null;
    }
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
        openTpl = null;
      }
      i++;
      bump(ch);
      continue;
    }
    if (ch === '$' && next === '{' && tplDepth > 0) {
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
    openSquote = pos();
    state = 'squote';
    i++;
    bump(ch);
    continue;
  }
  if (ch === '"') {
    openDquote = pos();
    state = 'dquote';
    i++;
    bump(ch);
    continue;
  }
  if (ch === '`') {
    if (tplDepth === 0) openTpl = pos();
    tplDepth++;
    state = 'tpl';
    i++;
    bump(ch);
    continue;
  }
  i++;
  bump(ch);
}

console.log('EOF state:', state);
if (openSquote) console.log('open squote at', openSquote);
if (openDquote) console.log('open dquote at', openDquote);
if (openTpl) console.log('open tpl at', openTpl, 'depth', tplDepth);

if (openSquote) {
  const hl = openSquote.htmlLine;
  const idx = hl - startHtmlLine;
  for (let j = Math.max(0, idx - 2); j <= Math.min(body.length - 1, idx + 8); j++) {
    console.log((startHtmlLine + j) + ': ' + body[j].slice(0, 140));
  }
}
