// Error reporting for the hub. Off unless SENTRY_DSN is set, so a dev hub and
// the test suite never load @sentry/node or touch the network. The SDK's own
// uncaughtException/unhandledRejection integrations capture process-level
// errors; server.mjs registers its own handlers, so the hub keeps serving.
export async function initSentry(env = process.env, load = () => import("@sentry/node")) {
  if (!env.SENTRY_DSN) return null;
  const Sentry = await load();
  Sentry.init({
    dsn: env.SENTRY_DSN,
    release: `zevet-hub@${env.ZEVET_VERSION || "unknown"}`,
    sendDefaultPii: false,
  });
  return Sentry;
}
