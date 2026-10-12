/** Let the editor paint before source propagation, recovery writes or toolbar work. */
export function afterEditorPaint(callback: () => void): () => void {
  let active = true;
  let task: ReturnType<typeof setTimeout> | undefined;
  const run = () => {
    if (!active) return;
    active = false;
    cancelAnimationFrame(frame);
    clearTimeout(task);
    clearTimeout(fallback);
    callback();
  };
  const frame = requestAnimationFrame(() => {
    task = setTimeout(run, 0);
  });
  // Background windows may not receive animation frames; saves must still progress.
  const fallback = setTimeout(run, 250);
  return () => {
    active = false;
    cancelAnimationFrame(frame);
    clearTimeout(task);
    clearTimeout(fallback);
  };
}
