import { chromium } from "playwright";

const BASE = process.env.CODEFLOWMU_URL || "http://127.0.0.1:18766";

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const consoleErrors = [];
  const pageErrors = [];

  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 20000 });
  await page.waitForTimeout(2500);

  const dash = await page.evaluate(() => ({
    dashMain: document.getElementById("dash-cnt-task")?.textContent?.trim() || "",
    dashSub: document.getElementById("dash-cnt-task-sub")?.textContent?.trim() || "",
    dashDoing: document.getElementById("dash-cnt-doing")?.textContent?.trim() || "",
    dashDone: document.getElementById("dash-cnt-done")?.textContent?.trim() || "",
    sumTotal: document.getElementById("sum-total")?.textContent?.trim() || "",
    connected: document.getElementById("stxt")?.textContent?.trim() || "",
  }));

  await page.evaluate(() => {
    if (typeof navTo === "function") navTo("tasks");
  });
  await page.waitForTimeout(1500);

  const tasks = await page.evaluate(() => {
    const err = typeof _renderSmokeSection;
    const smokeSection = document.getElementById("ts-smoke-test");
    const smokeCnt = document.getElementById("ts-cnt-smoke")?.textContent?.trim() || "";
    const adminCnt = document.getElementById("ts-cnt-admin")?.textContent?.trim() || "";
    const tcTask = document.getElementById("tc-task")?.textContent?.trim() || "";
    const smokeRows = [...(document.querySelectorAll("#tt-smoke-body tr[data-fn]") || [])].map(
      (tr) => tr.getAttribute("data-fn") || "",
    );
    const adminRows = [...(document.querySelectorAll("#tt-admin-body tr[data-fn]") || [])].map(
      (tr) => tr.getAttribute("data-fn") || "",
    );
    let classifySample = null;
    const taskList = window.tasks || [];
    if (typeof classifyTask === "function") {
      const pick = (suffix) =>
        taskList.find(
          (t) =>
            String(t.task_id || "").endsWith("-" + suffix) ||
            String(t.filename || "").includes("-" + suffix + "-"),
        );
      classifySample = {
        "018": classifyTask(pick("018") || { filename: "TASK-20260604-018-ADMIN-to-PM.md" }),
        "019": classifyTask(pick("019") || { filename: "TASK-20260604-019-ADMIN-to-PM.md" }),
        "024": classifyTask(pick("024") || { filename: "TASK-20260604-024-ADMIN-to-PM.md" }),
        "021": classifyTask(pick("021") || { filename: "TASK-20260604-021-PM-to-DEV.md" }),
      };
    }
    return {
      renderSmokeType: err,
      smokeSectionDisplay: smokeSection?.style?.display || "",
      smokeCnt,
      adminCnt,
      tcTask,
      smokeRows,
      adminRows,
      classifySample,
    };
  });

  await browser.close();

  const out = { base: BASE, dash, tasks, consoleErrors, pageErrors };
  console.log(JSON.stringify(out, null, 2));
  process.exit(pageErrors.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
