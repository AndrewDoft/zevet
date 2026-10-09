/* Leading + trailing throttle: the first call runs now, calls inside the next
 * `ms` collapse into ONE run at the end of the window. `flush` runs a pending
 * call immediately (a run that just ended must not wait out the window). */
export function throttle(fn, ms) {
  let timer = null;
  let pending = false;
  const open = () => {
    timer = setTimeout(() => {
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
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (pending) {
      pending = false;
      fn();
    }
  };
  return call;
}
