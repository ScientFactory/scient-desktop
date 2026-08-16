/**
 * SCIENT-OWNED fork title numbering.
 *
 * The server calls this at commit time and remains the collision authority.
 * Clients may call it to preview the automatic destination title, but an
 * untouched preview must never be sent back as an override.
 */

export interface ForkTitleThread {
  readonly id: string;
  readonly title: string;
}

/**
 * Derive the next collision-safe fork title for an origin thread.
 *
 * A numeric suffix is treated as generated fork numbering only when the
 * origin is itself a fork and the unsuffixed title exists on another thread.
 * This preserves meaningful titles such as "Study (2024)" and renamed forks.
 */
export function deriveForkTitle(input: {
  readonly origin: ForkTitleThread;
  readonly originHasForkLineage: boolean;
  /** Every thread in the origin's project, including the origin itself. */
  readonly projectThreads: ReadonlyArray<ForkTitleThread>;
}): string {
  const siblingTitles = new Set(input.projectThreads.map((thread) => thread.title));
  const suffixMatch = input.origin.title.match(/^(.*)\s+\(\d+\)$/);
  const candidateBaseTitle = suffixMatch?.[1]?.trim() ?? null;
  const hasVerifiedForkSuffix =
    input.originHasForkLineage &&
    candidateBaseTitle !== null &&
    input.projectThreads.some(
      (thread) => thread.id !== input.origin.id && thread.title === candidateBaseTitle,
    );
  const baseTitle =
    (hasVerifiedForkSuffix ? candidateBaseTitle : input.origin.title).trim() || "Fork";
  for (let suffix = 2; suffix <= 10_000; suffix += 1) {
    const candidate = `${baseTitle} (${suffix})`;
    if (!siblingTitles.has(candidate)) {
      return candidate;
    }
  }
  return `${baseTitle} (${input.origin.id.slice(-8)})`;
}
