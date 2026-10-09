/* A reply for `dir` is only about `dir`: when the open folder has moved on by the time an
 * async answer lands, the answer is dropped whole. Wrap every branch of the handler. */
export function whileOpen(currentRoot, dir, fn) {
  return (...args) => (currentRoot() === dir ? fn(...args) : undefined);
}
