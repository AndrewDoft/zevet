import { useEffect, useState } from "react";
import { serverNow } from "./board";

/** The server clock, re-read every `ms` while the window is shown and once the moment it is shown again. */
export function useVisibleNow(ms = 1000): number {
  const [now, setNow] = useState(() => serverNow());
  useEffect(() => {
    const tick = () => {
      if (!document.hidden) setNow(serverNow());
    };
    const t = setInterval(tick, ms);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [ms]);
  return now;
}
