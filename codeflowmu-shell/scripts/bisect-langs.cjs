const fs = require("fs");
const vm = require("vm");
const lines = fs
  .readFileSync("d:/codeflowmu/codeflowmu-shell/scripts/_inline-check.js", "utf8")
  .split("\n");

function test(a, b, label, wrap) {
  let code = lines.slice(a - 1, b).join("\n");
  if (wrap === "zh") code = "const LANGS={zh:{" + code + "}};";
  if (wrap === "tail") code = "const LANGS={zh:{" + lines[111] + code + "}};";
  try {
    new vm.Script(code);
    console.log(label, "OK");
    return true;
  } catch (e) {
    console.log(label, "FAIL", e.message);
    return false;
  }
}

test(43, 112, "zh props through mcpAgents", "zh");
test(43, 118, "zh props through detecting", "zh");
test(113, 200, "tail props after blank", "tail");
const ok120 = test(1, 120, "full start through 120", null);
if (!ok120) {
  for (let i = 43; i <= 120; i++) {
    const code = lines.slice(0, i).join("\n");
    try {
      new vm.Script(code);
    } catch (e) {
      if (e.message.includes("Unexpected identifier")) {
        console.log("breaks at extract line", i, lines[i - 1].slice(0, 80));
        break;
      }
    }
  }
}
