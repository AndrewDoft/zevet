// Preloaded into a test hub (NODE_OPTIONS=--import) so the hub's REAL GitHub
// device-flow code runs against a stand-in for github.com. Each device-code
// request is handed the next login in GH_STUB_USERS; approving is instant.
const users = (process.env.GH_STUB_USERS || "").split(",").filter(Boolean);
let n = 0;
const real = globalThis.fetch;
const reply = (o) => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
const idOf = (login) => [...login].reduce((a, c) => a * 31 + c.charCodeAt(0), 7) % 1000000;

globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u === "https://github.com/login/device/code") {
    const login = users[n++ % users.length];
    return reply({ device_code: `dc-${login}`, user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", interval: 5, expires_in: 900 });
  }
  if (u === "https://github.com/login/oauth/access_token") {
    const dc = JSON.parse(init.body).device_code;
    return reply({ access_token: `tok-${dc.slice(3)}`, token_type: "bearer" });
  }
  if (u === "https://api.github.com/user") {
    const login = String(init.headers.Authorization).slice("Bearer tok-".length);
    return reply({ login, id: idOf(login), name: login });
  }
  return real(url, init);
};
