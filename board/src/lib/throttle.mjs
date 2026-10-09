/* Leading + trailing throttle: the first call runs now, calls inside the next
 * `ms` collapse into ONE run at the end of the window. For store publishes
 * driven by streams (agent events arrive hundreds a second; React can paint
 * ~20 a second). `timers` is injectable so a test needs no real clock. */
export function throttle(fn, ms, timers = { set: (f, t) => setTimeout(f, t), clear: (h) => clearTimeout(h) }) {
  let timer = null;
  let pending = false;
  const open = () => {
    timer = timers.set(() => {
      timer = null;
      if (!pending) return;
      pending = false;
      fn();
      open();
    }, ms);
  };
  const call = () => {
    if (timer !== null) {
      pending = true;
      return;
    }
    fn();
    open();
  };
  call.flush = () => {
    if (timer !== null) timers.clear(timer);
    timer = null;
    if (pending) {
      pending = false;
      fn();
    }
  };
  return call;
}
