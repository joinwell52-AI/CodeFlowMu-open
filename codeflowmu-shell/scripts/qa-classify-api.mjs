import { classifyTask, countVisibleTaskBreakdown } from "../src/panel-task-thread-visibility.ts";

const url = "http://127.0.0.1:18766/api/v2/tasks?limit=500&source=auto";
const res = await fetch(url);
const { tasks } = await res.json();
const bd = countVisibleTaskBreakdown(tasks);
const mains = tasks.filter((t) => classifyTask(t) === "main");
const smokes = tasks.filter((t) => classifyTask(t) === "smoke");
console.log("breakdown", bd);
console.log(
  "main ids",
  mains.map((t) => t.task_id),
);
console.log(
  "smoke ids",
  smokes.map((t) => t.task_id),
);
