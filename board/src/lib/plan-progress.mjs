const STATUS = new Set(["pending", "in_progress", "active", "completed", "done"]);

function objectOf(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function text(value, fallback) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function normalise(items) {
  if (!Array.isArray(items)) return [];
  return items.map((item, index) => {
    const row = objectOf(item);
    const raw = String(row.status || "pending").toLowerCase();
    return {
      text: text(row.content ?? row.step ?? row.text ?? row.title, `step ${index + 1}`),
      status: STATUS.has(raw) ? (raw === "active" ? "in_progress" : raw === "done" ? "completed" : raw) : "pending",
    };
  });
}

export function planFromToolCall(toolName, args) {
  const name = String(toolName || "").toLowerCase();
  const input = objectOf(args);
  if (name === "todowrite" || name === "todo_write" || name === "todo") return normalise(input.todos ?? input.items);
  if (name === "update_plan" || name === "updateplan") return normalise(input.plan ?? input.steps ?? input.todos);
  return null;
}

export function planProgress(steps) {
  if (!Array.isArray(steps) || !steps.length) return null;
  const done = steps.filter((step) => step.status === "completed").length;
  const active = steps.find((step) => step.status === "in_progress");
  return { steps, done, total: steps.length, current: active?.text || "" };
}

export function latestPlan(messages) {
  let latest = null;
  for (const message of Array.isArray(messages) ? messages : []) {
    for (const part of Array.isArray(message?.content) ? message.content : []) {
      if (part?.type !== "tool-call") continue;
      const steps = planFromToolCall(part.toolName, part.args);
      if (steps) latest = planProgress(steps);
    }
  }
  return latest;
}
