const DEFAULT_FETCH_ATTEMPT_TIMEOUT_MS = 5_000;
const DEFAULT_WAIT_TIMEOUT_MS = 20_000;
const POLL_INTERVAL_MS = 100;

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

export async function waitFor(description, operation, timeoutMs = DEFAULT_WAIT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastError;

  while (Date.now() < deadline) {
    try {
      const result = await operation({
        deadline,
        remainingMs: Math.max(0, deadline - Date.now()),
      });
      if (result !== null && result !== false && result !== undefined) return result;
    } catch (error) {
      lastError = error;
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs > 0) await delay(Math.min(POLL_INTERVAL_MS, remainingMs));
  }

  const detail = lastError instanceof Error ? `: ${lastError.message}` : "";
  throw new Error(`Timed out waiting for ${description}${detail}`, { cause: lastError });
}

export async function fetchWithinDeadline(
  input,
  {
    deadline,
    attemptTimeoutMs = DEFAULT_FETCH_ATTEMPT_TIMEOUT_MS,
    consume = (response) => response,
    requestInit,
  },
) {
  const remainingMs = deadline - Date.now();
  if (remainingMs <= 0) throw new Error(`Deadline expired before requesting ${String(input)}.`);

  const timeoutMs = Math.max(1, Math.min(attemptTimeoutMs, remainingMs));
  const timeoutController = new AbortController();
  const signal = requestInit?.signal
    ? AbortSignal.any([requestInit.signal, timeoutController.signal])
    : timeoutController.signal;
  const timeout = setTimeout(() => {
    timeoutController.abort(
      new Error(`Request to ${String(input)} exceeded its ${timeoutMs}ms deadline.`),
    );
  }, timeoutMs);

  try {
    const response = await fetch(input, { ...requestInit, signal });
    return await consume(response);
  } finally {
    clearTimeout(timeout);
  }
}
