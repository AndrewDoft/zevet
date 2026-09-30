"use strict";

function shellQuote(p, platform = process.platform) {
  if (platform !== "win32") return `"${String(p).replace(/[\\"$`]/g, "\\$&")}"`;
  if (String(p).includes('"')) throw new Error(`path contains a quote: ${p}`);
  return `"${p}"`;
}

function hookCommand({ node, hook, repo, platform = process.platform }) {
  return `${shellQuote(node, platform)} ${shellQuote(hook, platform)} --zevet-hook --zevet-agent claude-code --zevet-repo ${shellQuote(repo, platform)}`;
}

function hasHookMarker(settings) {
  return JSON.stringify(settings?.hooks || {}).includes("--zevet-hook");
}

module.exports = { hookCommand, hasHookMarker, shellQuote };
