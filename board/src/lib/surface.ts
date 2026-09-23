import { createContext } from "react";

/** True inside Zevet Chat's thread. The composer's model, posture, context and
 *  slash controls all belong to a Code console, so there they render nothing.
 *  A context rather than a Thread prop: thread.aui.tsx is vendored and
 *  re-fetched by scripts/sync-registry.mjs, and this needs no patch there. */
export const ChatSurface = createContext(false);
