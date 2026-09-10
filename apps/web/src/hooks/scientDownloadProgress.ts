interface DownloadProgressFrame {
  readonly value: number;
  readonly velocity: number;
}

/** Display-only catch-up. The confirmed target is an absolute ceiling. */
export function advanceDownloadProgress(
  frame: DownloadProgressFrame,
  target: number,
  elapsedMs: number,
): DownloadProgressFrame {
  if (target <= frame.value) return { value: target, velocity: 0 };
  // Do not replay a large suspended/background frame as one jump.
  const seconds = Math.min(50, Math.max(0, elapsedMs)) / 1000;
  const gap = target - frame.value;
  const desiredVelocity = Math.min(100, Math.max(3, gap / 0.3));
  const velocity =
    frame.velocity + (desiredVelocity - frame.velocity) * (1 - Math.exp(-seconds / 0.2));
  const value = Math.min(target, frame.value + velocity * seconds);
  return value === target ? { value, velocity: 0 } : { value, velocity };
}

export function normalizeDownloadProgress(percent: number | null): number | null {
  return percent !== null && Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : null;
}
