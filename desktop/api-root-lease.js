"use strict";

/** Reference-counted temporary trust for concurrent board requests. */
function createApiRootLease() {
  const roots = new Map();
  return {
    add(root) { roots.set(root, (roots.get(root) || 0) + 1); },
    delete(root) {
      const count = roots.get(root) || 0;
      if (count <= 1) roots.delete(root);
      else roots.set(root, count - 1);
    },
    has(root) { return roots.has(root); },
  };
}

module.exports = { createApiRootLease };
