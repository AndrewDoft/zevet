import { createContext, useContext } from "react";

/** What the thread does not draw (lib/window.mjs): the count, the first drawn message, and the way to draw more. */
export const EarlierContext = createContext<{ hidden: number; firstId: string | undefined; widen: () => void }>({
  hidden: 0,
  firstId: undefined,
  widen: () => {},
});
export const useEarlier = () => useContext(EarlierContext);
