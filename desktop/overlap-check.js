"use strict";

const OVERLAP_THRESHOLDS = Object.freeze({ textOverlap: 0.82, textAdjacent: 0.62 });

function cosine(a, b) {
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < Math.max(a.length, b.length); i++) { const x = a[i] || 0, y = b[i] || 0; dot += x * y; aa += x * x; bb += y * y; }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
}
function pathsOf(x) { return new Set([...(x.openPaths || []), ...(x.plannedPaths || [])].map((p) => String(p).replaceAll("\\", "/").replace(/^\.\//, ""))); }

async function classifyOverlap({ task = "", branch = "", openPaths = [], plannedPaths = [], active = [], embed }) {
  const vectors = typeof embed === "function" ? await embed([task, ...active.map((x) => x.task || "")]) : [];
  const mine = pathsOf({ openPaths, plannedPaths });
  return active.map((other, i) => {
    const theirs = pathsOf(other);
    const samePath = [...mine].some((p) => theirs.has(p));
    const sameBranch = Boolean(branch && other.branch && branch === other.branch);
    // A claim has no task text: nothing to compare, and "" must not score.
    const score = other.task && vectors.length > i + 1 ? cosine(vectors[0], vectors[i + 1]) : 0;
    const dirOf = (p) => p.split("/").slice(0, -1).join("/");
    const sameDir = [...mine].some((p) => dirOf(p) && [...theirs].some((q) => dirOf(q) === dirOf(p)));
    const label = samePath || sameBranch || score >= OVERLAP_THRESHOLDS.textOverlap ? "overlapping" : (sameDir || score >= OVERLAP_THRESHOLDS.textAdjacent ? "adjacent" : null);
    return label ? { ...other, label, score } : null;
  }).filter(Boolean);
}


module.exports = { classifyOverlap, OVERLAP_THRESHOLDS, cosine };
