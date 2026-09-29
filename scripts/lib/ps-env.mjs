// make-feed.mjs's Authenticode check shells out to `powershell.exe` (Windows
// PowerShell 5.1, not pwsh) to run Get-AuthenticodeSignature. When the parent
// process IS pwsh 7, it inherits pwsh's PSModulePath -- pointed at pwsh's own
// module directories -- and Windows PowerShell's Security module (which is
// where Get-AuthenticodeSignature lives) fails to autoload from a path built
// for the other PowerShell, so the call errors instead of returning a status.
//
// Fix: drop PSModulePath from the child's env before spawning. With no
// PSModulePath set at all, Windows PowerShell falls back to its own built-in
// module path and resolves Security itself, exactly as it would with no
// pwsh in the process tree at all.
/**
 * `env` (default `process.env`) with every PSModulePath entry removed,
 * regardless of casing -- Windows env var lookups are case-insensitive, but a
 * plain JS object is not, so a stray `PSModulePath` versus `PSMODULEPATH`
 * would otherwise survive a case-sensitive delete. Never mutates `env`.
 */
export function psEnvWithoutModulePath(env = process.env) {
  const out = { ...env };
  for (const key of Object.keys(out)) {
    if (key.toLowerCase() === "psmodulepath") delete out[key];
  }
  return out;
}
