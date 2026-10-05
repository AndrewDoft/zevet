import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { ROOT } from "./helpers.mjs";

const require = createRequire(import.meta.url);
const { createApiRootLease } = require(path.join(ROOT, "desktop", "api-root-lease.js"));

test("overlapping board spawns keep the workspace trusted until all finish", async () => {
  const lease = createApiRootLease();
  const root = "C:\\repo";
  const started = Array.from({ length: 5 }, async (_, i) => {
    lease.add(root);
    await new Promise((resolve) => setTimeout(resolve, i === 0 ? 5 : 15));
    assert.equal(lease.has(root), true);
    lease.delete(root);
    return true;
  });

  assert.deepEqual(await Promise.all(started), [true, true, true, true, true]);
  assert.equal(lease.has(root), false);
});
