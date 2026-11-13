/**
 * Scient Agent's `wait` returns every few seconds to minutes when nothing happened. Waits on
 * grouped subagents show no row (as T3 does for Codex), idle repeats are dropped, anything
 * new stays visible, and a shown row is always settled.
 */

const WAIT_TOOL = "wait";
const MAX_LABEL_LENGTH = 80;

type JobType = "bash" | "task" | "eval";

interface WaitJob {
  readonly id: string;
  readonly type: JobType;
  readonly running: boolean;
  readonly label: string | undefined;
  /** The native agent id a task job runs as (`agentUrlId`), which subagent rows use. */
  readonly agentId: string;
}

interface WaitResult {
  /** Undefined when the result carries no readable job list. */
  readonly jobs: ReadonlyArray<WaitJob> | undefined;
  readonly senders: ReadonlyArray<string>;
  /** The agent marked it as nothing new: an idle window elapsed. */
  readonly idle: boolean;
  readonly interrupted: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const text = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.replace(/\s+/gu, " ").trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length <= MAX_LABEL_LENGTH
    ? trimmed
    : `${Array.from(trimmed)
        .slice(0, MAX_LABEL_LENGTH - 1)
        .join("")}…`;
};

const decodeJob = (value: unknown): WaitJob | undefined => {
  if (!isRecord(value)) return undefined;
  const id = text(value.id);
  const type = value.type;
  if (id === undefined || (type !== "bash" && type !== "task" && type !== "eval")) return undefined;
  return {
    id,
    type,
    running: value.status === "running",
    label: text(value.intent) ?? text(value.label),
    agentId: text(value.agentUrlId) ?? id,
  };
};

const decodeWait = (data: unknown): WaitResult => {
  const details = isRecord(data) && isRecord(data.details) ? data.details : undefined;
  const rawJobs = details?.jobs;
  const jobs = Array.isArray(rawJobs) ? rawJobs.map(decodeJob) : undefined;
  const senders = Array.isArray(details?.waited)
    ? details.waited.flatMap((message) => {
        const from = isRecord(message) ? text(message.from) : undefined;
        return from === undefined ? [] : [from];
      })
    : [];
  return {
    jobs: jobs === undefined || jobs.includes(undefined) ? undefined : (jobs as WaitJob[]),
    senders: [...new Set(senders)],
    idle: isRecord(data) && data.useless === true,
    interrupted: details?.interrupted === true,
  };
};

const jobsLabel = (jobs: ReadonlyArray<WaitJob>): string => {
  if (jobs.length === 0) return "background work";
  if (jobs.length === 1)
    return jobs[0]!.label ?? (jobs[0]!.type === "task" ? "a subagent" : "a background job");
  return jobs.every((job) => job.type === "task")
    ? `${jobs.length} subagents`
    : `${jobs.length} background jobs`;
};

const sendersLabel = (senders: ReadonlyArray<string>): string =>
  senders.length === 1
    ? `Message from ${senders[0]}`
    : senders.length === 2
      ? `Messages from ${senders[0]} and ${senders[1]}`
      : `Messages from ${senders[0]} and ${senders.length - 1} others`;

const jobsKey = (jobs: ReadonlyArray<WaitJob>) =>
  jobs
    .map((job) => job.id)
    .toSorted()
    .join("\n");

export class OmpWaitRows {
  /** Subagents this session has published, and whether each has settled. */
  readonly #subagents = new Map<string, boolean>();
  /** Shown wait rows still running: call id → what they wait for. */
  readonly #shown = new Map<string, string>();
  /** The jobs of the last idle wait, until other work happens in between. */
  #idleJobs: string | undefined;

  isWait(name: string): boolean {
    return name === WAIT_TOOL;
  }

  noteSubagent(id: string, settled: boolean): void {
    this.#subagents.set(id, settled);
  }

  /** Other work happened, so a next wait starts a new episode. */
  noteActivity(): void {
    this.#idleJobs = undefined;
  }

  /** A new turn: nothing shown is still running. Known subagents stay known. */
  reset(): void {
    this.#shown.clear();
    this.#idleJobs = undefined;
  }

  /** The row title for this wait update, or undefined to show no row for it. */
  title(
    callId: string,
    status: "running" | "completed" | "failed",
    data: unknown,
  ): string | undefined {
    const wait = decodeWait(data);
    const shown = this.#shown.get(callId);
    const grouped =
      wait.jobs !== undefined &&
      wait.jobs.length > 0 &&
      wait.jobs.every((job) => job.type === "task" && this.#subagents.has(job.agentId));

    if (status === "running") {
      if (shown !== undefined) return this.#waiting(callId, wait.jobs);
      // Progress frames carry the watched jobs; without them, wait for the result.
      if (wait.jobs === undefined || wait.jobs.length === 0 || grouped) return undefined;
      if (jobsKey(wait.jobs) === this.#idleJobs) return undefined;
      return this.#waiting(callId, wait.jobs);
    }

    this.#shown.delete(callId);
    const settledShown = shown === undefined ? undefined : `Waited for ${shown}`;
    if (status === "failed") return settledShown ?? "Wait failed";
    if (wait.senders.length > 0) return sendersLabel(wait.senders);
    // The agent flags a wait that brought nothing new; it never flags an error.
    if (wait.idle) {
      if (wait.jobs !== undefined && wait.jobs.length > 0) this.#idleJobs = jobsKey(wait.jobs);
      return settledShown;
    }
    const settled = wait.jobs?.filter((job) => !job.running);
    // Steering or a completion notice ended it; that shows on its own.
    if (wait.interrupted && (settled === undefined || settled.length === 0)) return settledShown;
    if (settled !== undefined && settled.length > 0) {
      const covered = settled.every(
        (job) => job.type === "task" && this.#subagents.get(job.agentId) === true,
      );
      if (covered) return settledShown;
      return settled.length === 1
        ? `Result from ${jobsLabel(settled)}`
        : `Results from ${jobsLabel(settled)}`;
    }
    // A service or reply wake, nothing left to wait on, or a result this cannot read.
    return settledShown ?? "Waited for background work";
  }

  #waiting(callId: string, jobs: ReadonlyArray<WaitJob> | undefined): string {
    const label =
      jobs === undefined ? (this.#shown.get(callId) ?? "background work") : jobsLabel(jobs);
    this.#shown.set(callId, label);
    return `Waiting for ${label}`;
  }
}
