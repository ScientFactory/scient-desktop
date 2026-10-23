/** MathLive's mount event precedes its first rendered formula. Keep that event
 * intact and publish a separate, cancellable paint-readiness signal. */
export function observeMathFieldReadiness(
  field: HTMLElement,
  container: HTMLElement,
  empty: boolean,
  deadline = 3000,
) {
  let frame = 0;
  let previous = "";
  let stable = 0;
  const started = performance.now();
  delete field.dataset.scientMathReady;
  const check = () => {
    if (!field.isConnected) return;
    const ink = field.shadowRoot?.querySelector<HTMLElement>(".ML__latex");
    const rect = ink?.getBoundingClientRect();
    const geometry = rect ? `${rect.width}:${rect.height}` : "";
    if (ink && (empty || (rect!.width > 0 && rect!.height > 0))) {
      stable = geometry === previous ? stable + 1 : 0;
      previous = geometry;
      if (stable >= 2) {
        field.dataset.scientMathReady = "true";
        container.dispatchEvent(new CustomEvent("scient-latex-math-ready", { bubbles: true }));
        return;
      }
    } else stable = 0;
    if (performance.now() - started >= deadline) {
      field.dataset.scientMathReady = "failed";
      container.dispatchEvent(new CustomEvent("scient-latex-math-ready", { bubbles: true }));
    } else frame = requestAnimationFrame(check);
  };
  frame = requestAnimationFrame(check);
  return () => {
    cancelAnimationFrame(frame);
    delete field.dataset.scientMathReady;
  };
}
