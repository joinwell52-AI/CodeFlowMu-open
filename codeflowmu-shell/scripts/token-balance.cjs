'use strict';
const fs = require('fs');
const path = require('path');

const htmlPath = path.join(__dirname, '../../codeflowmu-desktop/panel/index.html');
const lines = fs.readFileSync(htmlPath, 'utf8').split(/\r?\n/);
const src = lines.slice(3766, 18113).join('\n');

// Minimal JS lexer: tracks templates, strings, comments, brace/paren/bracket
let i = 0;
let tplDepth = 0;
let brace = 0;
let paren = 0;
let bracket = 0;
let state = 'code'; // code | squote | dquote | tpl | linecomment | blockcomment
let tplExpr = 0;
const stack = [];
let line = 1;
let col = 0;
let lastTplOpen = null;

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
      if (tplDepth === 0) state = 'code';
      i++;
      bump(ch);
      continue;
    }
    if (ch === '$' && next === '{' && tplDepth > 0) {
      stack.push({ type: 'tpl-expr', line, col, tplDepth });
      tplExpr++;
      brace++;
      i += 2;
      state = 'code';
      continue;
    }
    i++;
    bump(ch);
    continue;
  }

  // code
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
    if (tplDepth === 0) {
      lastTplOpen = { line, col };
      state = 'tpl';
    }
    tplDepth++;
    i++;
    bump(ch);
    continue;
  }
  if (ch === '{') {
    brace++;
    stack.push({ type: '{', line, col });
  } else if (ch === '}') {
    brace--;
    if (stack.length && stack[stack.length - 1].type === 'tpl-expr') {
      stack.pop();
      tplExpr--;
    } else if (stack.length && stack[stack.length - 1].type === '{') {
      stack.pop();
    }
  } else if (ch === '(') {
    paren++;
    stack.push({ type: '(', line, col });
  } else if (ch === ')') {
    paren--;
    if (stack.length && stack[stack.length - 1].type === '(') stack.pop();
  } else if (ch === '[') {
    bracket++;
    stack.push({ type: '[', line, col });
  } else if (ch === ']') {
    bracket--;
    if (stack.length && stack[stack.length - 1].type === '[') stack.pop();
  }
  i++;
  bump(ch);
}

console.log('EOF state:', state);
console.log('tplDepth:', tplDepth, 'lastTplOpen:', lastTplOpen);
console.log('brace:', brace, 'paren:', paren, 'bracket:', bracket, 'tplExpr:', tplExpr);
console.log('stack tail (last 15):');
console.log(stack.slice(-15));
