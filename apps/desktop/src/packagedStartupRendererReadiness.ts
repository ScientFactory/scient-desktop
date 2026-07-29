// This expression runs inside the packaged renderer through Electron's
// executeJavaScript boundary. Keep it data-only so the release verifier can
// exercise the exact expression without importing the Electron main process.
export const PACKAGED_RENDERER_READINESS_EXPRESSION =
  "document.readyState === 'complete' && document.documentElement.dataset.scientRendererReady === 'true'";

const PACKAGED_RENDERER_READINESS_TIMEOUT_MS = 30_000;
const PACKAGED_RENDERER_READINESS_INTERVAL_MS = 100;

export interface PackagedRendererReadinessOptions {
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
  readonly now?: () => number;
  readonly delay?: (ms: number) => Promise<void>;
}

type RendererReadinessEvaluation = "ready" | "not-ready" | "timed-out";

async function evaluateRendererReadinessWithin(
  evaluate: () => Promise<unknown>,
  timeoutMs: number,
): Promise<RendererReadinessEvaluation> {
  return new Promise<RendererReadinessEvaluation>((resolve) => {
    let settled = false;
    const timeout = setTimeout(() => {
      settled = true;
      resolve("timed-out");
    }, timeoutMs);

    void Promise.resolve().then(evaluate).then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(value === true ? "ready" : "not-ready");
      },
      () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve("not-ready");
      },
    );
  });
}

/**
 * Wait for the renderer-owned hydration marker within a bounded startup budget.
 * A one-frame sample races React hydration on slower packaged targets, while
 * polling still requires the renderer to prove the exact same ready state.
 */
export async function waitForPackagedRendererReadiness(
  evaluate: () => Promise<unknown>,
  options?: PackagedRendererReadinessOptions,
): Promise<boolean> {
  const timeoutMs = options?.timeoutMs ?? PACKAGED_RENDERER_READINESS_TIMEOUT_MS;
  const intervalMs = options?.intervalMs ?? PACKAGED_RENDERER_READINESS_INTERVAL_MS;
  const now = options?.now ?? (() => Date.now());
  const delay =
    options?.delay ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + timeoutMs;

  for (;;) {
    const remainingMs = deadline - now();
    if (remainingMs <= 0) return false;

    const evaluation = await evaluateRendererReadinessWithin(evaluate, remainingMs);
    if (evaluation === "ready") return true;
    if (evaluation === "timed-out") return false;

    const remainingAfterEvaluationMs = deadline - now();
    if (remainingAfterEvaluationMs <= 0) return false;
    await delay(Math.min(intervalMs, remainingAfterEvaluationMs));
  }
}
