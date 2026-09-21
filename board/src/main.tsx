import { createRoot } from "react-dom/client";
import "./index.css";
import "./styles/masora.css";
import App from "./App";

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

createRoot(document.getElementById("root")!).render(<App />);
