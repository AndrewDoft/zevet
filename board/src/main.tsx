import { createRoot } from "react-dom/client";
import "./index.css";
import "./styles/masora.css";
import { bridge } from "./lib/bridge";
import { hydratePrefsMirror } from "./lib/prefs-mirror.mjs";

/* Every "zevet.*" preference a person set, off this machine rather than off
 * whichever hub served this page — before "./App" (and, through it, ./lib/
 * board's `create<BoardState>` call) is even imported, since that is where
 * localStorage is first read into the store's initial state. See
 * lib/prefs-mirror.mjs. No-op without a desktop bridge. */
await hydratePrefsMirror(window.localStorage, bridge.local);

/* The fixture bridge is dev-only twice over: the module is behind
 * import.meta.env.DEV, which rollup resolves to false and drops, and it still
 * needs ?dev=1 before it installs anything. See lib/fixture.ts. */
if (import.meta.env.DEV) {
  const { installFixtureBridge } = await import("./lib/fixture");
  if (installFixtureBridge()) {
    // The store, reachable from the console and from a driving script. Half
    // the panels render nothing until some fact is in here, and "it rendered
    // nothing" and "the fact never arrived" look identical from outside.
    const { useBoard } = await import("./lib/board");
    (window as unknown as Record<string, unknown>).__zevetStore = useBoard;
  }
}

const { default: App } = await import("./App");
createRoot(document.getElementById("root")!).render(<App />);
