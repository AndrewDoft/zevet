import { createRoot } from "react-dom/client";
import "./index.css";
import "./styles/masora.css";
import App from "./App";

/* The fixture bridge is dev-only twice over: the module is behind
 * import.meta.env.DEV, which rollup resolves to false and drops, and it still
 * needs ?dev=1 before it installs anything. See lib/fixture.ts. */
if (import.meta.env.DEV) {
  const { installFixtureBridge } = await import("./lib/fixture");
  installFixtureBridge();
}

createRoot(document.getElementById("root")!).render(<App />);
