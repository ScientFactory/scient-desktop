// @effect-diagnostics nodeBuiltinImport:off - test-only replay binds host paths and pins the original controlled transcript.
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as Predicate from "effect/Predicate";
import type { ProviderReplayTranscript, ProviderReplayEntry } from "@t3tools/contracts";

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
    const declaredCanonical = NodePath.dirname(initial.file) === this.stateRoot;
    if (declaredCanonical && actualFile !== initial.file)
      throw new Error("Pi replay launch differs from its independently declared session file.");
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
          NodePath.dirname(identity.file) === this.stateRoot
            ? identity.file
            : NodePath.join(this.stateRoot, `replay-${encodeURIComponent(identity.id)}.jsonl`),
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

/** Finite overlays for older recordings, never an adaptive replay matcher. */
const recordedPiSchedules: Readonly<
  Record<string, { readonly digest: string; readonly states: ReadonlyArray<number> }>
> = {
  multi_turn: {
    digest: "ae2b62f17365f0b8e07633a1efe2e2977d48ecd03a6c8cf01b54e0748b2883d5",
    states: [43, 76],
  },
  pi_compaction: {
    digest: "1ef8e13b9d6e641309e731396401ef0c9d8817665b059033d202892cd2c0a994",
    states: [46, 64, 96, 128, 146, 188],
  },
  provider_thread_resume: {
    digest: "b97af5c924913990c50f0ee0230a1e4f7a6cec5deb9920eb143121cead6c0617",
    states: [59, 126],
  },
  message_steering: {
    digest: "d5529d72f19e7d4bacdda5b39974e330007293b904ede4c7efdb46673b447531",
    states: [63],
  },
  thread_rollback: {
    digest: "64ddcf990c4b3d3e6114e9220e5eee54cfbb8920ab533ea65496e1872b1cd889",
    states: [54, 87, 171],
  },
  thread_rollback_after_stop: {
    digest: "ed2599685fb3d50f07fe020885c506b43ab3ab32b67cd46d71ba4e495192b207",
    states: [44, 216, 286],
  },
};

/**
 * Keep native activity and correlated read-only pairs intact. Confirmations are
 * static fixture observations, not freshly observed vendor state. Streaming
 * identity preflight deliberately does not reuse the earlier idle predicate.
 */
export function reconcilePiRecordedSchedules(input: {
  readonly scenario: string;
  readonly entries: ReadonlyArray<ProviderReplayEntry>;
}): ReadonlyArray<ProviderReplayEntry> {
  const pin = Object.hasOwn(recordedPiSchedules, input.scenario)
    ? recordedPiSchedules[input.scenario]
    : undefined;
  if (pin === undefined) return reconcilePiSimpleSettleTail(input);
  const { entries } = input;
  const refuse = (): never => {
    throw new Error(`Pi ${input.scenario} replay schedule no longer matches its pinned recording.`);
  };
  if (NodeCrypto.createHash("sha256").update(JSON.stringify(entries)).digest("hex") !== pin.digest)
    refuse();
  const response = (index: number, command: string) => {
    const entry = entries[index];
    if (
      entry?.type !== "emit_inbound" ||
      !Predicate.isObject(entry.frame) ||
      entry.frame.type !== "response" ||
      entry.frame.command !== command ||
      entry.frame.success !== true ||
      !Predicate.isObject(entry.frame.data)
    )
      return refuse();
    return { entry, frame: entry.frame, data: entry.frame.data };
  };
  const syntheticState = (
    state: ReturnType<typeof response>,
    id: string,
    purpose: string,
    data = state.data,
  ): Array<ProviderReplayEntry> => {
    if (
      entries.some(
        (entry) =>
          entry.type !== "runtime_exit" && Predicate.isObject(entry.frame) && entry.frame.id === id,
      )
    )
      refuse();
    const suffix = processOrdinal(state.entry) === 1 ? "" : `@p${processOrdinal(state.entry)}`;
    return [
      {
        type: "expect_outbound",
        label: `synthetic:${purpose}:get_state${suffix}`,
        frame: { type: "get_state", id },
      },
      {
        type: "emit_inbound",
        label: `synthetic:${purpose}:response:get_state${suffix}`,
        frame: { ...state.frame, id, data },
      },
    ];
  };
  const replacements = new Map<number, ReadonlyArray<ProviderReplayEntry>>();
  for (const [ordinal, index] of pin.states.entries()) {
    const state = response(index, "get_state");
    const stats = response(index + 4, "get_session_stats");
    if (
      state.data.isStreaming !== false ||
      state.data.isCompacting !== false ||
      state.data.pendingMessageCount !== 0 ||
      state.data.sessionFile !== stats.data.sessionFile ||
      state.data.sessionId !== stats.data.sessionId ||
      state.data.thinkingLevel !== "high" ||
      !Predicate.isObject(state.data.model) ||
      state.data.model.provider !== "openrouter" ||
      state.data.model.id !== "deepseek/deepseek-v4-flash"
    )
      refuse();
    const confirmation = syntheticState(state, `t3-${910000 + ordinal}`, "settle-confirmation");
    if (input.scenario === "pi_compaction" && (index === 64 || index === 146)) {
      // compaction_end and the compact ACK independently probe idle state.
      // Gate both reads before replying so both tree cursors retain the same
      // pinned boundary. These extra replies are static fixture observations.
      const duplicatePair = (
        offset: number,
        id: string,
        command: string,
      ): Array<ProviderReplayEntry> => {
        const original = entries[index + offset]!;
        const reply = response(index + offset + 1, command);
        if (original.type !== "expect_outbound" || !Predicate.isObject(original.frame))
          return refuse();
        if (
          entries.some(
            (entry) =>
              entry.type !== "runtime_exit" &&
              Predicate.isObject(entry.frame) &&
              entry.frame.id === id,
          )
        )
          refuse();
        return [
          {
            ...original,
            label: `synthetic:concurrent-compaction-probe:${command}`,
            frame: { ...original.frame, id },
          },
          {
            ...reply.entry,
            label: `synthetic:concurrent-compaction-probe:response:${command}`,
            frame: { ...reply.frame, id },
          },
        ];
      };
      const statistics = duplicatePair(3, `t3-${930000 + ordinal * 3}`, "get_session_stats");
      const tree = duplicatePair(1, `t3-${930001 + ordinal * 3}`, "get_entries");
      replacements.set(index + 1, [
        entries[index + 3]!,
        statistics[0]!,
        entries[index + 4]!,
        statistics[1]!,
        entries[index + 1]!,
        tree[0]!,
        entries[index + 2]!,
        tree[1]!,
        ...confirmation,
        ...syntheticState(state, `t3-${930002 + ordinal * 3}`, "settle-confirmation"),
      ]);
    } else {
      replacements.set(index + 1, [
        entries[index + 3]!,
        entries[index + 4]!,
        entries[index + 1]!,
        entries[index + 2]!,
        ...confirmation,
      ]);
    }
  }
  const result: Array<ProviderReplayEntry> = [];
  for (let index = 0; index < entries.length; index += 1) {
    if (input.scenario === "message_steering" && index === 27) {
      const selected = response(15, "get_state");
      // The pinned agent_start/message prefix establishes active streaming;
      // only identity and selection are copied from the earlier observation.
      result.push(
        ...syntheticState(selected, "t3-920000", "streaming-identity-preflight", {
          sessionFile: selected.data.sessionFile,
          sessionId: selected.data.sessionId,
          model: selected.data.model,
          thinkingLevel: selected.data.thinkingLevel,
          isStreaming: true,
          isCompacting: false,
          pendingMessageCount: 0,
        }),
      );
    }
    const replacement = replacements.get(index);
    if (replacement === undefined) result.push(entries[index]!);
    else {
      result.push(...replacement);
      index += 3;
    }
  }
  return result;
}

/** Fresh-file entropy is fixed before execution; native allocation and validation still run. */
const PI_REPLAY_FRESH_FILE_ID = "00000000-0000-4000-8000-000000000000";

/** Independent declarations and observed stdio are separate proof inputs. */
export function declarePiReplaySessionFiles(
  entries: ReadonlyArray<ProviderReplayEntry>,
  root: string,
) {
  if (!NodePath.isAbsolute(root) || NodePath.resolve(root) !== root)
    throw new Error("Pi replay declaration needs a canonical private directory.");
  const identities = new Map<string, RecordedSession>();
  const ids = new Set<string>();
  for (const entry of entries) {
    const state = recordedState(entry);
    if (state === undefined) continue;
    const previous = identities.get(state.file);
    if (
      (previous !== undefined && previous.id !== state.id) ||
      (previous === undefined && ids.has(state.id))
    )
      throw new Error("Pi replay declaration changed a session identity.");
    identities.set(state.file, state);
    ids.add(state.id);
  }
  if (identities.size === 0) throw new Error("Pi replay declaration has no session identity.");
  const sessions = [...identities.values()].map((identity, index) => ({
    ...identity,
    canonicalFile: NodePath.join(
      root,
      `${index === 0 ? PI_REPLAY_FRESH_FILE_ID : `replay-${encodeURIComponent(identity.id)}`}.jsonl`,
    ),
  }));
  const expectedFile = (alias: string) => {
    const declared = sessions.find((session) => session.file === alias);
    if (declared === undefined) throw new Error("Pi replay session alias is undeclared.");
    return declared.canonicalFile;
  };
  const rebind = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(rebind);
    if (!Predicate.isObject(value)) return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        (key === "sessionFile" || key === "sessionPath") && typeof child === "string"
          ? expectedFile(child)
          : rebind(child),
      ]),
    );
  };
  const bound = entries.map((entry, index): ProviderReplayEntry => {
    if (entry.type === "runtime_exit") return entry;
    const frame = rebind(entry.frame);
    if (
      entry.type !== "expect_outbound" ||
      !Predicate.isObject(frame) ||
      frame.type !== "process_start"
    )
      return { ...entry, frame };
    const state = entries
      .slice(index + 1)
      .find(
        (candidate) =>
          processOrdinal(candidate) === processOrdinal(entry) &&
          recordedState(candidate) !== undefined,
      );
    const identity = state === undefined ? undefined : recordedState(state);
    if (
      identity === undefined ||
      !Array.isArray(frame.args) ||
      !frame.args.every((arg) => typeof arg === "string")
    )
      throw new Error("Pi replay declaration has an invalid process start.");
    const flags = frame.args.flatMap((arg, position) => (arg === "--session" ? [position] : []));
    if (
      flags.length > 1 ||
      (flags.length === 1 &&
        (flags[0] !== frame.args.length - 2 || frame.args.at(-1) !== identity.file))
    )
      throw new Error("Pi replay declaration has an invalid launch identity.");
    const args = flags.length === 0 ? frame.args : frame.args.slice(0, -2);
    return {
      ...entry,
      frame: { ...frame, args: [...args, "--session", expectedFile(identity.file)] },
    };
  });
  return { sessions, entries: bound, expectedFile };
}

type PiReplayFixtureEvidence = ReturnType<typeof declarePiReplaySessionFiles> & {
  readonly observed: Array<ProviderReplayEntry>;
};
const fixtureEvidence = new WeakMap<ProviderReplayTranscript, PiReplayFixtureEvidence>();

/** Register declarations before spawning; callers cannot infer expectations from runtime output. */
export function registerPiReplayFixtureEvidence(
  transcript: ProviderReplayTranscript,
  root: string,
) {
  if (fixtureEvidence.has(transcript)) throw new Error("Pi replay fixture was already registered.");
  const observed: Array<ProviderReplayEntry> = [];
  const evidence = { ...declarePiReplaySessionFiles(transcript.entries, root), observed };
  fixtureEvidence.set(transcript, evidence);
  return evidence;
}

export function piReplayExpectedSessionFile(transcript: ProviderReplayTranscript, alias: string) {
  const evidence = fixtureEvidence.get(transcript);
  if (evidence === undefined) throw new Error("Pi replay fixture has no independent binding.");
  return evidence.expectedFile(alias);
}

/** Every reopened process must read back its declared UUID/file before its first prompt. */
export function assertPiReplayConfirmedLaunches(
  transcript: ProviderReplayTranscript,
  alias: string,
) {
  const evidence = fixtureEvidence.get(transcript);
  if (evidence === undefined) throw new Error("Pi replay fixture has no launch evidence.");
  const declared = evidence.sessions.find((session) => session.file === alias);
  if (declared === undefined) throw new Error("Pi replay fixture has no declared session.");
  const starts = evidence.observed.filter(
    (entry) =>
      entry.type === "expect_outbound" &&
      Predicate.isObject(entry.frame) &&
      entry.frame.type === "process_start",
  );
  if (starts.length !== 2) throw new Error("Pi replay must witness exactly two native launches.");
  for (const [index, start] of starts.entries()) {
    const ordinal = index + 1;
    if (
      start.type !== "expect_outbound" ||
      !Predicate.isObject(start.frame) ||
      processOrdinal(start) !== ordinal ||
      !Array.isArray(start.frame.args) ||
      start.frame.args.filter((arg) => arg === "--session").length !== 1 ||
      start.frame.args.at(-2) !== "--session" ||
      start.frame.args.at(-1) !== declared.canonicalFile
    )
      throw new Error("Pi replay observed a different launch file or ordinal.");
    const startIndex = evidence.observed.indexOf(start);
    const promptIndex = evidence.observed.findIndex(
      (entry, position) =>
        position > startIndex &&
        processOrdinal(entry) === ordinal &&
        entry.type === "expect_outbound" &&
        Predicate.isObject(entry.frame) &&
        entry.frame.type === "prompt",
    );
    if (promptIndex < 0) throw new Error("Pi replay launch has no native prompt.");
    const prefix = evidence.observed.slice(startIndex + 1, promptIndex);
    const replyIndex = prefix.findIndex(
      (entry) =>
        entry.type === "emit_inbound" &&
        processOrdinal(entry) === ordinal &&
        Predicate.isObject(entry.frame) &&
        entry.frame.command === "get_state",
    );
    const reply = prefix[replyIndex];
    const state = reply === undefined ? undefined : recordedState(reply);
    if (
      reply?.type !== "emit_inbound" ||
      !Predicate.isObject(reply.frame) ||
      reply.frame.type !== "response" ||
      state?.file !== declared.canonicalFile ||
      state.id !== declared.id
    )
      throw new Error("Pi replay launch lacks its initial same-session get_state confirmation.");
    const id = reply.frame.id;
    if (
      !prefix
        .slice(0, replyIndex)
        .some(
          (request) =>
            request.type === "expect_outbound" &&
            processOrdinal(request) === ordinal &&
            Predicate.isObject(request.frame) &&
            request.frame.type === "get_state" &&
            request.frame.id === id,
        )
    )
      throw new Error("Pi replay launch lacks a correlated same-session get_state confirmation.");
    if (
      ordinal > 1 &&
      prefix.some(
        (entry) =>
          entry.type === "expect_outbound" &&
          Predicate.isObject(entry.frame) &&
          entry.frame.type === "switch_session",
      )
    )
      throw new Error("Pi replay reopened launch redundantly switched its already bound session.");
  }
}

/**
 * Historical reopened RPC pairs remain explicit evidence, outside the current
 * executable schedule. Current Pi binds --session at launch and confirms it
 * with the original get_state reply. Never pretend the obsolete RPC was sent.
 */
export function reconcilePiBoundLaunchProtocol(input: {
  readonly scenario: string;
  readonly entries: ReadonlyArray<ProviderReplayEntry>;
}) {
  const prepared = reconcilePiRecordedSchedules(input);
  const start =
    input.scenario === "provider_thread_resume"
      ? 64
      : input.scenario === "thread_rollback_after_stop"
        ? 160
        : undefined;
  const historicalRPCFrames: Array<ProviderReplayEntry> = [];
  if (start === undefined) return { entries: prepared, historicalRPCFrames };
  // reconcilePiRecordedSchedules pins the complete original recording first.
  const request = input.entries[start + 1]!;
  const reply = input.entries[start + 7]!;
  const confirmation = input.entries[start + 9]!;
  const initial = input.entries.find((entry) => recordedState(entry) !== undefined);
  const initialIdentity = initial === undefined ? undefined : recordedState(initial);
  const reopened = recordedState(confirmation);
  if (
    request.type !== "expect_outbound" ||
    !Predicate.isObject(request.frame) ||
    request.label !== "switch_session@p2" ||
    request.frame.type !== "switch_session" ||
    reply.type !== "emit_inbound" ||
    !Predicate.isObject(reply.frame) ||
    reply.label !== "response:switch_session@p2" ||
    reply.frame.command !== "switch_session" ||
    reply.frame.success !== true ||
    reply.frame.id !== request.frame.id ||
    reopened === undefined ||
    initialIdentity === undefined ||
    processOrdinal(confirmation) !== 2 ||
    request.frame.sessionPath !== initialIdentity.file ||
    reopened.file !== initialIdentity.file ||
    reopened.id !== initialIdentity.id
  )
    throw new Error("Pi reopened launch adaptation changed its pinned identity or confirmation.");
  historicalRPCFrames.push(request, reply);
  return {
    entries: prepared.filter((entry) => entry !== request && entry !== reply),
    historicalRPCFrames,
  };
}

export function piReplayObservedEntries(transcript: ProviderReplayTranscript) {
  const evidence = fixtureEvidence.get(transcript);
  if (evidence === undefined) throw new Error("Pi replay fixture has no observed native frames.");
  return evidence.observed;
}
