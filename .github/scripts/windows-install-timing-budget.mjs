// Deadlines of the Windows install timing harness, on a clock and sleep the tests can drive.

/** `ms`, cut to what remains before `deadline`; 0 once it has passed. */
export function until(clock, deadline, ms) {
  return Math.max(0, Math.min(ms, Math.floor(deadline - clock())));
}

/**
 * A budget ending `totalMs` from now. `left(ms)` cuts a bound to what remains of it;
 * `deadline(ms)` is `ms` from now but never past the budget, and null once it is spent.
 */
export function measurementBudget(clock, totalMs) {
  const end = clock() + totalMs;
  return {
    left: (ms) => until(clock, end, ms),
    deadline(ms) {
      const now = clock();
      return now < end ? Math.min(now + ms, end) : null;
    },
  };
}

/** When a launch starts, read right before it does; null once `deadline` has passed. */
export function startBefore(clock, deadline) {
  const now = clock();
  return now < deadline ? now : null;
}

/**
 * True once `predicate(left)` holds, false at `deadline`. The predicate cuts each of its own
 * bounds with `left(ms)`, so no check runs past the deadline.
 */
export async function waitUntil({ clock, sleep }, predicate, deadline, intervalMs) {
  const left = (ms) => until(clock, deadline, ms);
  while (left(1) > 0) {
    if (await predicate(left)) return true;
    await sleep(left(intervalMs));
  }
  return false;
}

/**
 * The readiness deadline of a launch whose checks `prepare` runs first: read again once they
 * finish, right before the launch starts, so slow checks never extend it past the budget.
 * `{ spent: true }` when the budget runs out before or during the checks; a failed check's result
 * as it is.
 */
export async function readyDeadline(budget, readyMs, prepare) {
  if (budget.deadline(readyMs) === null) return { spent: true };
  const prepared = await prepare();
  if (prepared.failure) return prepared;
  const deadline = budget.deadline(readyMs);
  return deadline === null ? { spent: true } : { ...prepared, deadline };
}
