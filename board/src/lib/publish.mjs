import { throttle } from "./throttle.mjs";

/* Publishes in-place mutations of a list as a fresh array, at most once per `ms`.
 * Agent events arrive by the hundred a second and every publish re-renders thread, rail and composer. */
export function consolePublisher(read, write, ms = 50) {
  return throttle(() => write([...read()]), ms);
}
