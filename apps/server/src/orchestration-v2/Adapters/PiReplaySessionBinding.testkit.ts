// @effect-diagnostics nodeBuiltinImport:off - test-only replay binds host paths and pins the original controlled transcript.
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as Predicate from "effect/Predicate";
import type { ProviderReplayEntry } from "@t3tools/contracts";

interface RecordedSession {
  readonly file: string;
  readonly id: string;
}

function processOrdinal(entry: ProviderReplayEntry): number {
  const label = entry.type === "runtime_exit" ? undefined : entry.label;
  const match = label === undefined ? null : /@p(\d+)$/u.exec(label);
  return match === null ? 1 : Number(match[1]);
}
function recordedState(entry: ProviderReplayEntry): RecordedSession | undefined {
  if (
    entry.type !== "emit_inbound" ||
    !Predicate.isObject(entry.frame) ||
    entry.frame.command !== "get_state" ||
    entry.frame.success !== true ||
    !Predicate.isObject(entry.frame.data)
  )
    return undefined;
  const { sessionFile, sessionId } = entry.frame.data;
  if (
    typeof sessionFile !== "string" ||
    typeof sessionId !== "string" ||
    !NodePath.isAbsolute(sessionFile) ||
    sessionId.length === 0
  )
    throw new Error("Pi replay get_state requires an exact recorded session file and id.");
  return { file: sessionFile, id: sessionId };
}

/** Rebind recorded native file identities only; argv, ids, frames and ordinal ownership stay strict. */
export class PiReplaySessionBinding {
  private readonly identities = new Map<string, RecordedSession>();
  private readonly files = new Map<string, string>();
  private readonly started = new Set<number>();
  private cwd: string | undefined;
  private readonly launches = new Map<number, ReadonlyArray<string>>();
  private readonly original: ReadonlyArray<ProviderReplayEntry>;
  private readonly stateRoot: string;
  constructor(original: ReadonlyArray<ProviderReplayEntry>, stateRoot: string) {
    this.original = original;
    this.stateRoot = stateRoot;
    const ids = new Map<string, string>();
    for (const entry of original) {
      const state = recordedState(entry);
      if (state === undefined) continue;
      const previous = this.identities.get(state.file);
      if (
        (previous !== undefined && previous.id !== state.id) ||
        (ids.has(state.id) && ids.get(state.id) !== state.file)
      )
        throw new Error("Pi replay recorded session identity is inconsistent.");
      this.identities.set(state.file, state);
      ids.set(state.id, state.file);
    }
  }

  bind(input: {
    readonly ordinal: number;
    readonly args: ReadonlyArray<string>;
    readonly cwd: string;
  }) {
    if (this.started.has(input.ordinal) || input.ordinal !== this.started.size + 1)
      throw new Error("Pi replay process ordinal is duplicate or out of order.");
    if (!NodePath.isAbsolute(input.cwd) || (this.cwd !== undefined && this.cwd !== input.cwd))
      throw new Error("Pi replay process belongs to another workspace.");
    const starts = this.original.filter(
      (entry) =>
        entry.type === "expect_outbound" &&
        Predicate.isObject(entry.frame) &&
        entry.frame.type === "process_start" &&
        processOrdinal(entry) === input.ordinal,
    );
    if (starts.length !== 1)
      throw new Error("Pi replay requires one recorded process start at its ordinal.");
    const start = starts[0]!;
    if (
      start.type !== "expect_outbound" ||
      !Predicate.isObject(start.frame) ||
      !Array.isArray(start.frame.args) ||
      !start.frame.args.every((arg) => typeof arg === "string")
    )
      throw new Error("Pi replay process argv is invalid.");
    const startIndex = this.original.indexOf(start);
    const firstState = this.original
      .slice(startIndex + 1)
      .find(
        (entry) => processOrdinal(entry) === input.ordinal && recordedState(entry) !== undefined,
      );
    const initial = firstState === undefined ? undefined : recordedState(firstState);
    if (initial === undefined)
      throw new Error("Pi replay process has no recorded initial session identity.");
    const sessionFlags = input.args.flatMap((arg, index) => (arg === "--session" ? [index] : []));
    if (sessionFlags.length !== 1 || sessionFlags[0] !== input.args.length - 2)
      throw new Error("Pi replay launch requires exactly one final owned --session pair.");
    const actualFile = input.args.at(-1)!;
    if (
      NodePath.dirname(actualFile) !== this.stateRoot ||
      NodePath.resolve(actualFile) !== actualFile ||
      !actualFile.endsWith(".jsonl")
    )
      throw new Error("Pi replay launch session file is foreign or noncanonical.");
    const previousFile = this.files.get(initial.file);
    if (previousFile !== undefined && previousFile !== actualFile)
      throw new Error("Pi replay reopen changed its recorded session identity.");
    if (previousFile === undefined && [...this.files.values()].includes(actualFile))
      throw new Error("Pi replay launch reused another recorded session file.");
    const originalArgs = start.frame.args;
    const declaredFlags = originalArgs.flatMap((arg, index) =>
      arg === "--session" ? [index] : [],
    );
    if (
      declaredFlags.length > 1 ||
      (declaredFlags.length === 1 &&
        (declaredFlags[0] !== originalArgs.length - 2 || originalArgs.at(-1) !== initial.file))
    )
      throw new Error("Pi replay recorded launch has a wrong or duplicate session identity.");
    const baseArgs = declaredFlags.length === 0 ? originalArgs : originalArgs.slice(0, -2);
    const actualBase = input.args.slice(0, -2);
    if (
      baseArgs.length !== actualBase.length ||
      baseArgs.some((arg, index) => arg !== "<any>" && arg !== actualBase[index])
    )
      throw new Error("Pi replay launch changed a recorded argv value or order.");
    this.cwd = input.cwd;
    this.started.add(input.ordinal);
    this.files.set(initial.file, actualFile);
    this.launches.set(input.ordinal, [...baseArgs, "--session", actualFile]);
    for (const identity of this.identities.values()) {
      if (!this.files.has(identity.file))
        this.files.set(
          identity.file,
          NodePath.join(this.stateRoot, `replay-${encodeURIComponent(identity.id)}.jsonl`),
        );
    }
    const entries = this.original.map((entry): ProviderReplayEntry => {
      if (entry.type === "runtime_exit") return entry;
      const frame = this.rebind(entry.frame);
      if (
        entry.type === "expect_outbound" &&
        Predicate.isObject(frame) &&
        frame.type === "process_start" &&
        this.launches.has(processOrdinal(entry))
      )
        return { ...entry, frame: { ...frame, args: this.launches.get(processOrdinal(entry)) } };
      return { ...entry, frame };
    });
    return {
      entries,
      headers: [...this.identities.values()].map((identity) => ({
        file: this.files.get(identity.file)!,
        id: identity.id,
        cwd: input.cwd,
      })),
    };
  }

  private rebind(value: unknown): unknown {
    if (Array.isArray(value)) return value.map((entry) => this.rebind(entry));
    if (!Predicate.isObject(value)) return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => {
        if ((key === "sessionFile" || key === "sessionPath") && typeof entry === "string") {
          const rebound = this.files.get(entry);
          if (rebound === undefined)
            throw new Error("Pi replay frame references an undeclared session file.");
          return [key, rebound];
        }
        return [key, this.rebind(entry)];
      }),
    );
  }
}

/** Adapt only the pinned simple recording's read-only settle schedule, never native activity. */
export function reconcilePiSimpleSettleTail(input: {
  readonly scenario: string;
  readonly entries: ReadonlyArray<ProviderReplayEntry>;
}): ReadonlyArray<ProviderReplayEntry> {
  if (input.scenario !== "simple") return input.entries;
  const entries = input.entries;
  const fail = () => {
    throw new Error("Pi simple replay settle tail differs from its pinned recording.");
  };
  if (entries.length !== 49) return fail();
  const settled = entries[42]!;
  const stateRequest = entries[43]!;
  const stateResponse = entries[44]!;
  const entriesRequest = entries[45]!;
  const entriesResponse = entries[46]!;
  const statsRequest = entries[47]!;
  const statsResponse = entries[48]!;
  if (
    settled.type !== "emit_inbound" ||
    settled.label !== "agent_settled" ||
    !Predicate.isObject(settled.frame) ||
    settled.frame.type !== "agent_settled" ||
    stateRequest.type !== "expect_outbound" ||
    stateRequest.label !== "get_state" ||
    !Predicate.isObject(stateRequest.frame) ||
    stateRequest.frame.type !== "get_state" ||
    stateRequest.frame.id !== "t3-6" ||
    stateResponse.type !== "emit_inbound" ||
    stateResponse.label !== "response:get_state" ||
    !Predicate.isObject(stateResponse.frame) ||
    stateResponse.frame.command !== "get_state" ||
    stateResponse.frame.type !== "response" ||
    stateResponse.frame.success !== true ||
    stateResponse.frame.id !== stateRequest.frame.id ||
    !Predicate.isObject(stateResponse.frame.data) ||
    entriesRequest.type !== "expect_outbound" ||
    entriesRequest.label !== "get_entries" ||
    !Predicate.isObject(entriesRequest.frame) ||
    entriesRequest.frame.type !== "get_entries" ||
    entriesRequest.frame.id !== "t3-7" ||
    entriesRequest.frame.since !== "670d1d31" ||
    entriesResponse.type !== "emit_inbound" ||
    entriesResponse.label !== "response:get_entries" ||
    !Predicate.isObject(entriesResponse.frame) ||
    entriesResponse.frame.command !== "get_entries" ||
    entriesResponse.frame.type !== "response" ||
    entriesResponse.frame.success !== true ||
    entriesResponse.frame.id !== entriesRequest.frame.id ||
    !Predicate.isObject(entriesResponse.frame.data) ||
    entriesResponse.frame.data.leafId !== "ac4aa63e" ||
    statsRequest.type !== "expect_outbound" ||
    statsRequest.label !== "get_session_stats" ||
    !Predicate.isObject(statsRequest.frame) ||
    statsRequest.frame.type !== "get_session_stats" ||
    statsRequest.frame.id !== "t3-8" ||
    statsResponse.type !== "emit_inbound" ||
    statsResponse.label !== "response:get_session_stats" ||
    !Predicate.isObject(statsResponse.frame) ||
    statsResponse.frame.command !== "get_session_stats" ||
    statsResponse.frame.type !== "response" ||
    statsResponse.frame.success !== true ||
    statsResponse.frame.id !== statsRequest.frame.id ||
    !Predicate.isObject(statsResponse.frame.data)
  )
    return fail();
  const state = stateResponse.frame.data;
  const stats = statsResponse.frame.data;
  if (
    state.sessionFile !== "/pi-sessions/session-1.jsonl" ||
    state.sessionId !== "00000000-0000-4000-8000-000000000002" ||
    stats.sessionFile !== state.sessionFile ||
    stats.sessionId !== state.sessionId ||
    state.isStreaming !== false ||
    state.isCompacting !== false ||
    state.pendingMessageCount !== 0 ||
    state.thinkingLevel !== "high" ||
    !Predicate.isObject(state.model) ||
    state.model.provider !== "openrouter" ||
    state.model.id !== "deepseek/deepseek-v4-flash"
  )
    return fail();
  const confirmationId = "t3-900003";
  if (
    entries.some(
      (entry) =>
        entry.type !== "runtime_exit" &&
        Predicate.isObject(entry.frame) &&
        entry.frame.id === confirmationId,
    )
  )
    return fail();
  // Pin every deciding native frame and original order, including all five tree entries.
  if (
    NodeCrypto.createHash("sha256").update(JSON.stringify(entries)).digest("hex") !==
    "fa7609d0f9d35787b3817d8e82c301f33b7d5395dd9be1dbb11c76fa4a1f54f5"
  )
    return fail();
  return [
    ...entries.slice(0, 45),
    statsRequest,
    statsResponse,
    entriesRequest,
    entriesResponse,
    {
      type: "expect_outbound",
      label: "synthetic:settle-confirmation:get_state",
      frame: { type: "get_state", id: confirmationId },
    },
    // Static replay confirmation copied from recorded idle truth, not a new vendor observation.
    {
      ...stateResponse,
      label: "synthetic:settle-confirmation:response:get_state",
      frame: { ...stateResponse.frame, id: confirmationId },
    },
  ];
}
