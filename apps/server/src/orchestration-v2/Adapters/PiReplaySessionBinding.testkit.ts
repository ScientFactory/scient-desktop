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

/**
 * Upstream made Pi's skill-command discovery lazy: ordinary recordings without
 * a $skill reference no longer contain these startup RPCs. Archive the removed
 * correlated lines here so the current fixtures can prove byte-for-byte
 * provenance against the original recordings without relying on git history.
 */
export const piReplayFixtureProvenance = {
  simple: {
    liveDigest: "94c02b2a4c160960e802ce7a60500ede4f2bcdf1acda015ecd2b807d09f629c8",
    originalDigest: "e22ab72047abe327745e481bf6290fe381f6bd990f51e47228869fb50bb0b8c0",
    reopened: false,
  },
  multi_turn: {
    liveDigest: "a1d513eff3be6c55eab7e9c9b8411531a3f8d710bcad87442f651512d3483097",
    originalDigest: "71b8237c9be726330faa7a9d8e7ae1888966bbe8f16ffd0096593459b3afb1a7",
    reopened: false,
  },
  pi_compaction: {
    liveDigest: "86650a95ce59c17a924babd523664d95c1fa066b3fb362dffabf99f487aff8b9",
    originalDigest: "26226612d6558dbb6a3bcc5ae696859a5106e1e2b3ab1b52a2138f2dae043a67",
    reopened: false,
  },
  provider_thread_resume: {
    liveDigest: "185d652abd58478516a218bed51abc36205c4da869d29fc2689c3b175c1f7133",
    originalDigest: "9b54ec08420f59e0fa94786f91baebd7e0ae045343e7f568324163fb12fdcf38",
    reopened: true,
  },
  message_steering: {
    liveDigest: "697bc09d2f06e2ad39b52e1c73b83f0e84b34458ab3e743faf9d9afac135cfa8",
    originalDigest: "57eed804122a202e5804019400e576fdf337221f23c9b7231b0e8b19b2cf20ab",
    reopened: false,
  },
  thread_rollback: {
    liveDigest: "5c188585e6a18349a9da7513837428f4c063f471fe969765d68adeaea60dda90",
    originalDigest: "bd1ddccb72e23676b8c22fda18e9b456457ff18df82354b829b113c4b87edac5",
    reopened: false,
    initialResponseAfterModelsRequest: true,
  },
  thread_rollback_after_stop: {
    liveDigest: "4501b147a9cca12db9992c85b6ef76deed7e46a55235e1be641d5f9e14780d07",
    originalDigest: "e66dc46f638aa02af9d14817ece8cf4c8cd245613695ef596237b75a938f8f25",
    reopened: true,
  },
  turn_interrupt_mid_tool: {
    liveDigest: "fda7e49b3ee7b86d1a8b04fe864c1a56623c3a180a3c7b1c3203a0a57cb900f7",
    originalDigest: "b50659656021ebc140cfe82ca309bff241a6dcb6853360ed13c1af709e0ab373",
    reopened: false,
  },
} as const;

/** Restore only the official lazy-discovery delta and verify both full-byte receipts. */
export function restorePiOriginalSkillDiscoveryRecording(input: {
  readonly scenario: string;
  readonly liveBytes: string;
}): string {
  const provenance = Object.entries(piReplayFixtureProvenance).find(
    ([scenario]) => scenario === input.scenario,
  )?.[1];
  if (provenance === undefined) throw new Error("Unknown Pi replay fixture provenance.");
  if (
    NodeCrypto.createHash("sha256").update(input.liveBytes).digest("hex") !== provenance.liveDigest
  )
    throw new Error(`Pi ${input.scenario} live fixture bytes differ from the reviewed recording.`);
  if (!input.liveBytes.endsWith("\n"))
    throw new Error(`Pi ${input.scenario} live fixture is missing its final newline.`);

  const lines = input.liveBytes.slice(0, -1).split("\n");
  const decodeLine = (line: string): unknown => {
    try {
      return JSON.parse(line);
    } catch {
      throw new Error(`Pi ${input.scenario} fixture contains an invalid JSONL row.`);
    }
  };
  const locate = (
    predicate: (record: Record<string, unknown>, frame: Record<string, unknown>) => boolean,
  ) => {
    const matches: Array<number> = [];
    for (const [index, line] of lines.entries()) {
      const record = decodeLine(line);
      if (!Predicate.isObject(record) || !Predicate.isObject(record.frame)) continue;
      if (predicate(record, record.frame)) matches.push(index);
    }
    if (matches.length !== 1)
      throw new Error(`Pi ${input.scenario} fixture lacks a unique skill-discovery anchor.`);
    return matches[0]!;
  };
  const hasSkillDiscoveryFrame = (record: unknown) => {
    if (!Predicate.isObject(record) || !Predicate.isObject(record.frame)) return false;
    return (
      record.frame.type === "get_commands" ||
      (record.frame.type === "response" && record.frame.command === "get_commands")
    );
  };
  if (lines.some((line) => hasSkillDiscoveryFrame(decodeLine(line))))
    throw new Error(`Pi ${input.scenario} live fixture already contains skill-discovery frames.`);
  const insertAfter = (
    predicate: (record: Record<string, unknown>, frame: Record<string, unknown>) => boolean,
    line: string,
  ) => lines.splice(locate(predicate) + 1, 0, line);
  const outbound =
    (label: string, type: string, id: string) =>
    (record: Record<string, unknown>, frame: Record<string, unknown>) =>
      record.type === "expect_outbound" &&
      record.label === label &&
      frame.type === type &&
      frame.id === id;
  const inbound =
    (label: string, command: string, id: string) =>
    (record: Record<string, unknown>, frame: Record<string, unknown>) =>
      record.type === "emit_inbound" &&
      record.label === label &&
      frame.type === "response" &&
      frame.command === command &&
      frame.id === id;
  const request =
    '{"type":"expect_outbound","label":"get_commands","frame":{"type":"get_commands","id":"t3-1"}}';
  const response =
    '{"type":"emit_inbound","label":"response:get_commands","frame":{"id":"t3-1","type":"response","command":"get_commands","success":true,"data":{"commands":[]}}}';
  insertAfter(outbound("get_state", "get_state", "t3-0"), request);
  insertAfter(
    "initialResponseAfterModelsRequest" in provenance &&
      provenance.initialResponseAfterModelsRequest === true
      ? outbound("get_available_models", "get_available_models", "t3-2")
      : inbound("response:get_state", "get_state", "t3-0"),
    response,
  );
  if (provenance.reopened) {
    insertAfter(
      outbound("switch_session@p2", "switch_session", "t3-0"),
      '{"type":"expect_outbound","label":"get_commands@p2","frame":{"type":"get_commands","id":"t3-1"}}',
    );
    insertAfter(
      (record, frame) =>
        record.type === "emit_inbound" &&
        record.label === "extension_ui_request@p2" &&
        frame.type === "extension_ui_request" &&
        frame.id === "00000000-0000-4000-8000-000000000003",
      '{"type":"emit_inbound","label":"response:get_commands@p2","frame":{"id":"t3-1","type":"response","command":"get_commands","success":true,"data":{"commands":[]}}}',
    );
  }

  const restoredBytes = `${lines.join("\n")}\n`;
  if (
    NodeCrypto.createHash("sha256").update(restoredBytes).digest("hex") !==
    provenance.originalDigest
  )
    throw new Error(`Pi ${input.scenario} fixture differs beyond the lazy-discovery edit.`);
  return restoredBytes;
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
  if (entries.length !== 47) return fail();
  const settled = entries[40]!;
  const stateRequest = entries[41]!;
  const stateResponse = entries[42]!;
  const entriesRequest = entries[43]!;
  const entriesResponse = entries[44]!;
  const statsRequest = entries[45]!;
  const statsResponse = entries[46]!;
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
    "5e8019ee5d21344a897e59d31a09233ea72738fd82c5933435538d87fd987ac8"
  )
    return fail();
  return [
    ...entries.slice(0, 43),
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
    digest: "84da8d5ab3b9b500dcbc2681b1d0c575401965553881c6bbe764cc27780b702b",
    states: [41, 74],
  },
  pi_compaction: {
    digest: "de6c27e1fadb538654e93d5d65882a81fc6a461f4a9d7011b458bcbfae4f2e83",
    states: [44, 62, 94, 126, 144, 186],
  },
  provider_thread_resume: {
    digest: "6ec26787a941b714f1867d0a175ede364d6d312dace70e0333c51e9c15c398ac",
    states: [57, 122],
  },
  message_steering: {
    digest: "5bffbb8e116e6d7f228726e3f5f226f1a86230e3692ca6cf0a263028a37076cf",
    states: [61],
  },
  thread_rollback: {
    digest: "3519b99523e0b61a69c30b7c577bc95e1cdead26e681bf9a66f9f429bf3263fe",
    states: [52, 85, 169],
  },
  thread_rollback_after_stop: {
    digest: "7cdf647104f7123086ada95f77d37da0fb9e171a19cd3e70df0811f19c50b66b",
    states: [42, 212, 282],
  },
  turn_interrupt_mid_tool: {
    digest: "c6e5325118f4fad39a0ece6eabeb5eb28793243d5703ae670550cf958cb4b83a",
    states: [],
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
    if (input.scenario === "pi_compaction" && (index === 62 || index === 144)) {
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
    if (input.scenario === "message_steering" && index === 25) {
      const selected = response(13, "get_state");
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
      ? 62
      : input.scenario === "thread_rollback_after_stop"
        ? 158
        : undefined;
  const historicalRPCFrames: Array<ProviderReplayEntry> = [];
  if (start === undefined) return { entries: prepared, historicalRPCFrames };
  // reconcilePiRecordedSchedules pins the complete current recording first.
  const request = input.entries[start + 1]!;
  const reply = input.entries[start + 5]!;
  const confirmation = input.entries[start + 7]!;
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
