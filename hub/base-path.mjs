// The hub can sit under a path of another origin (app.usemasora.com/hub/): the proxy strips the prefix and says
// which one in X-Forwarded-Prefix, so the hub's routes never change. What does change is every root-relative URL
// the page, the board bundle and the stylesheet hand to the browser; those get the prefix here, once.

/** "/hub" from the header, "" for none. Anything but one plain segment is ignored: the value lands in a cookie path and a script. */
export function basePrefix(headers) {
  const v = String(headers["x-forwarded-prefix"] ?? "").replace(/\/+$/, "");
  return /^\/[A-Za-z0-9_-]+$/.test(v) ? v : "";
}

// Runs before board.js: the bundle calls fetch("/api/state"), new EventSource("/events") and new WebSocket(.../ws).
const shim = (p) => `<script>(function(b){var f=function(u){return typeof u==="string"&&u[0]==="/"&&u[1]!=="/"?b+u:u};
var F=window.fetch;window.fetch=function(u,o){return F.call(this,u instanceof Request?u:f(u),o)};
var E=window.EventSource;window.EventSource=function(u,o){return new E(f(u),o)};window.EventSource.prototype=E.prototype;
var O=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){arguments[1]=f(u);return O.apply(this,arguments)};
var W=window.WebSocket;window.WebSocket=function(u,p){if(typeof u==="string"){var x=new URL(u,location.href);if(x.host===location.host&&x.pathname[0]==="/"&&x.pathname.indexOf(b+"/")!==0)x.pathname=b+x.pathname;u=x.href}return p===undefined?new W(u):new W(u,p)};
window.WebSocket.prototype=W.prototype;["CONNECTING","OPEN","CLOSING","CLOSED"].forEach(function(k){window.WebSocket[k]=W[k]});
window.__zevetBase=b})(${JSON.stringify(p)});</script>`;

/** index.html as served under the prefix. */
export const htmlUnder = (html, p) => (p ? html.replace("<head>", `<head>\n    ${shim(p)}`).replace(/(href|src)="\//g, `$1="${p}/`) : html);

/** board.css as served under the prefix: its @font-face urls. */
export const cssUnder = (css, p) => (p ? css.replace(/url\((["']?)\/fonts\//g, `url($1${p}/fonts/`) : css);
