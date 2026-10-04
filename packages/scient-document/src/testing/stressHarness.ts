import type {
  DocumentPersistenceCoordinator,
  DocumentPersistenceFailureKind,
  DocumentPersistenceOptions,
  DocumentPersistenceReadResult,
  DocumentReconciliation,
} from "../persistenceCoordinator.ts";
import type { DocumentSaveIntent } from "../session.ts";

/**
 * Randomized interleavings for any document format: local typing and long
 * typing bursts, agent writes to the same file, ordered saves and reads that
 * succeed, conflict, disconnect, or fail ambiguously, watcher hints, deferred
 * external updates (as during IME composition), renames, and explicit conflict
 * choices. A format describes its tracked units; this harness checks that no
 * user or agent change is silently lost, that saving never silently stalls,
 * and that the coordinator settles on the disk bytes.
 */

export type StressSide = "local" | "agent";
export type StressOwner = StressSide | "shared";

export interface StressEdit {
  readonly source: string;
  readonly key: string;
  /** `undefined` records that the unit was removed. */
  readonly value: string | undefined;
}

export interface StressDocumentFormat {
  readonly initial: string;
  /** The current value of every tracked unit; units missing from the map are absent. */
  readonly values: (source: string) => ReadonlyMap<string, string>;
  readonly owner: (key: string) => StressOwner;
  /** One edit by one side, or null when it has nothing to edit. `stamp` is unique per run. */
  readonly edit: (
    source: string,
    side: StressSide,
    random: () => number,
    stamp: string,
  ) => StressEdit | null;
  /** Format-level checks for every published source; returns a problem or null. */
  readonly validate?: (source: string) => string | null;
}

export interface StressScenario<R extends DocumentReconciliation> {
  readonly format: StressDocumentFormat;
  readonly createCoordinator: (
    options: Omit<DocumentPersistenceOptions<R>, "reconcile">,
  ) => DocumentPersistenceCoordinator<R>;
  /** Advances fake timers and flushes the work they schedule. */
  readonly advanceTime: (ms: number) => Promise<void>;
  readonly seed: number;
  readonly steps: number;
}

export interface StressStats {
  readonly choices: number;
  readonly merges: number;
  /** Merges that combined unsaved local edits with an external change. */
  readonly mergesWithLocalEdits: number;
  readonly conflicts: number;
  readonly disconnects: number;
  readonly renames: number;
  readonly refusedDuringRename: number;
  readonly bursts: number;
  readonly deferrals: number;
  /** Merged updates the view declined or failed to apply. */
  readonly viewRefusals: number;
}

export interface StressResult {
  readonly violations: readonly string[];
  readonly stats: StressStats;
}

const DEBOUNCE_MS = 50;
const MAX_WAIT_MS = 200;

type Pending =
  | {
      readonly kind: "write";
      readonly owner: object;
      readonly intent: DocumentSaveIntent;
      readonly resolve: (value: { readonly revision: string }) => void;
      readonly reject: (error: unknown) => void;
    }
  | {
      readonly kind: "read";
      readonly owner: object;
      readonly resolve: (value: DocumentPersistenceReadResult) => void;
      readonly reject: (error: unknown) => void;
    };

const FAILURE_KINDS: readonly DocumentPersistenceFailureKind[] = [
  "conflict",
  "transient",
  "operation",
  "disconnected",
];

const classifyFailure = (error: unknown): DocumentPersistenceFailureKind =>
  FAILURE_KINDS.find((kind) => kind === error) ?? "terminal";

export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export async function runStressScenario<R extends DocumentReconciliation>(
  scenario: StressScenario<R>,
): Promise<StressResult> {
  const { format, seed } = scenario;
  const next = seededRandom(seed);
  const violations: string[] = [];
  const violation = (message: string) => violations.push(`seed ${seed}: ${message}`);
  let counter = 0;
  let disk = { source: format.initial, revision: "r0" };
  const pending: Pending[] = [];
  // Values each side set that must survive unless that side's changes were
  // explicitly discarded through a conflict choice.
  let localExpectations = new Map<string, string | undefined>();
  let agentExpectations = new Map<string, string | undefined>();
  // Shared units are edited by both sides; conflicts on them are resolved by an
  // explicit choice. Without any choice, the latest write in time must win.
  const latestShared = new Map<string, string>();
  const produced = new Set<string>(format.values(format.initial).values());
  const stats = {
    choices: 0,
    merges: 0,
    mergesWithLocalEdits: 0,
    conflicts: 0,
    disconnects: 0,
    renames: 0,
    refusedDuringRename: 0,
    bursts: 0,
    deferrals: 0,
    viewRefusals: 0,
  };
  let connected = true;
  let composing = false;
  let deferred = false;
  let renameRelease: (() => void) | null = null;
  let lastConflict: string | null = null;
  // The draft when the view last declined a merge, while unsaved edits existed.
  let refusedOver: string | null = null;

  const create = (source: string, revision: string) => {
    const owner = {};
    const coordinator = scenario.createCoordinator({
      source,
      revision,
      classifyFailure,
      debounceMs: DEBOUNCE_MS,
      maxWaitMs: MAX_WAIT_MS,
      retryDelaysMs: [10, 20, 40],
      write: (intent) =>
        new Promise((resolve, reject) =>
          pending.push({ kind: "write", owner, intent, resolve, reject }),
        ),
      read: () =>
        new Promise((resolve, reject) => pending.push({ kind: "read", owner, resolve, reject })),
      // A view that is composing text defers external updates. A view may also
      // decline or fail to apply a merge; both sides must then be kept for an
      // explicit choice. Otherwise the merged source is applied as-is.
      prepareExternalUpdate: () => {
        if (composing) {
          deferred = true;
          stats.deferrals += 1;
          return "defer";
        }
        const refusal = next();
        if (refusal < 0.06) {
          stats.viewRefusals += 1;
          const state = snapshot();
          refusedOver = state.draftSource !== state.baselineSource ? state.draftSource : null;
        }
        if (refusal < 0.04) return null;
        if (refusal < 0.06) {
          return () => {
            throw new Error("The view could not apply the merged update.");
          };
        }
        const withLocalEdits = snapshot().draftSource !== snapshot().baselineSource;
        return () => {
          stats.merges += 1;
          if (withLocalEdits) stats.mergesWithLocalEdits += 1;
        };
      },
    });
    return { coordinator, owner };
  };
  let current = create(format.initial, "r0");
  const snapshot = () => current.coordinator.getSnapshot();

  const keepLocal = (externalRevision: string) => {
    stats.choices += 1;
    refusedOver = null;
    const draft = format.values(snapshot().draftSource);
    agentExpectations = new Map([...agentExpectations].filter(([k, v]) => draft.get(k) === v));
    void current.coordinator.resolveWithLocal(externalRevision);
  };
  const useDisk = () => {
    stats.choices += 1;
    refusedOver = null;
    const values = format.values(disk.source);
    localExpectations = new Map([...localExpectations].filter(([k, v]) => values.get(k) === v));
    void current.coordinator.resolveWithDisk();
  };
  const choose = () => {
    const conflict = snapshot().conflict;
    if (conflict === null) return;
    if (next() < 0.5) keepLocal(conflict.externalRevision);
    else useDisk();
  };

  const settle = async () => {
    for (let index = 0; index < 6; index += 1) await Promise.resolve();
    // A declined merge leaves unsaved edits exactly as they were.
    if (refusedOver !== null && snapshot().draftSource !== refusedOver)
      violation("a merge the view declined was applied anyway");
    refusedOver = null;
  };
  const observe = () => {
    const conflict = snapshot().conflict;
    const identity = conflict === null ? null : conflict.externalRevision;
    if (identity !== null && identity !== lastConflict) stats.conflicts += 1;
    lastConflict = identity;
  };

  const checkPublished = (source: string, where: string) => {
    const problem = format.validate?.(source);
    if (problem) violation(`${where}: ${problem}`);
  };

  const completeOldest = (failures: boolean) => {
    const operation = pending.shift();
    if (!operation) return;
    if (operation.owner !== current.owner) {
      violation("an operation from a retired coordinator was still in flight");
    }
    if (operation.kind === "read") {
      const roll = failures ? next() : 1;
      if (roll < 0.08) operation.reject("transient");
      else if (roll < 0.1) operation.reject("disconnected");
      else operation.resolve({ ...disk });
      return;
    }
    const { intent } = operation;
    if (intent.expectedRevision !== disk.revision) {
      operation.reject("conflict");
      return;
    }
    const before = failures ? next() : 1;
    // The request never reached the file.
    if (before < 0.05) return operation.reject("transient");
    if (before < 0.07) return operation.reject("disconnected");
    if (before < 0.08) return operation.reject("operation");
    const previous = format.values(disk.source);
    const written = format.values(intent.source);
    for (const [key, value] of agentExpectations) {
      if (
        format.owner(key) === "agent" &&
        previous.get(key) === value &&
        written.get(key) !== value
      )
        violation(`write overwrote agent ${key}=${String(value)}`);
    }
    checkPublished(intent.source, "write");
    counter += 1;
    disk = { source: intent.source, revision: `w${counter}` };
    const after = failures ? next() : 1;
    // Published, but the acknowledgement was lost.
    if (after < 0.06) return operation.reject("transient");
    if (after < 0.08) return operation.reject("disconnected");
    operation.resolve({ revision: disk.revision });
  };

  const localEdit = () => {
    const before = snapshot();
    counter += 1;
    const edit = format.edit(before.draftSource, "local", next, `u${counter}`);
    if (edit === null) return;
    const accepted = current.coordinator.change(edit.source);
    if (renameRelease !== null) {
      if (accepted || snapshot().draftSource !== before.draftSource)
        violation("an edit was accepted while a rename held the file");
      if (!snapshot().editingBlocked) violation("a rename hold did not block editing");
      stats.refusedDuringRename += 1;
      return;
    }
    if (!accepted) return;
    localExpectations.set(edit.key, edit.value);
    if (edit.value !== undefined) produced.add(edit.value);
    if (format.owner(edit.key) === "shared" && edit.value !== undefined)
      latestShared.set(edit.key, edit.value);
    if (snapshot().draftSource !== edit.source) violation("accepted change is not the draft");
  };

  const agentEdit = () => {
    counter += 1;
    const edit = format.edit(disk.source, "agent", next, `x${counter}`);
    if (edit === null) return;
    disk = { source: edit.source, revision: `x${counter}` };
    agentExpectations.set(edit.key, edit.value);
    if (edit.value !== undefined) produced.add(edit.value);
    if (format.owner(edit.key) === "shared" && edit.value !== undefined)
      latestShared.set(edit.key, edit.value);
    if (next() < 0.6) current.coordinator.noteFreshnessHint();
  };

  // Continuous typing must not postpone saving forever: past the maximum wait,
  // either a save or read has started, or the snapshot shows why it cannot.
  const burst = async () => {
    stats.bursts += 1;
    const issuedBefore = pending.length;
    const length = 5 + Math.floor(next() * 25);
    let elapsed = 0;
    for (let index = 0; index < length; index += 1) {
      localEdit();
      const gap = Math.floor(next() * 30);
      elapsed += gap;
      await scenario.advanceTime(gap);
      await settle();
    }
    const state = snapshot();
    const explained =
      pending.length > issuedBefore ||
      state.error !== null ||
      state.conflict !== null ||
      state.retrying ||
      state.inFlight ||
      state.reading ||
      state.editingBlocked ||
      deferred ||
      !state.pending;
    if (elapsed >= MAX_WAIT_MS + DEBOUNCE_MS && !explained)
      violation("a long typing burst never started a save and showed no reason");
  };

  const rename = () => {
    if (renameRelease === null) {
      renameRelease = current.coordinator.holdForRename();
      return;
    }
    const release = renameRelease;
    renameRelease = null;
    if (next() < 0.5) {
      // The rename failed; the same file stays open.
      release();
      return;
    }
    // The rename succeeded: the clean bytes on disk move to the new name.
    if (!current.coordinator.retireClean()) {
      violation("a held, clean coordinator could not retire after a rename");
      release();
      return;
    }
    const moved = format.values(disk.source);
    for (const [key, value] of localExpectations) {
      if (format.owner(key) === "local" && moved.get(key) !== value)
        violation(`rename moved bytes without local ${key}=${String(value)}`);
    }
    stats.renames += 1;
    composing = false;
    deferred = false;
    current = create(disk.source, disk.revision);
  };

  // Reconnecting must resume saving by itself, without a new edit or hint.
  const toggleConnection = async () => {
    connected = !connected;
    current.coordinator.setConnected(connected);
    if (!connected) {
      stats.disconnects += 1;
      return;
    }
    await settle();
    const quiet = pending.length === 0;
    await scenario.advanceTime(DEBOUNCE_MS + MAX_WAIT_MS);
    await settle();
    const state = snapshot();
    if (
      quiet &&
      pending.length === 0 &&
      state.pending &&
      state.error === null &&
      state.conflict === null &&
      !state.retrying &&
      !state.editingBlocked &&
      !deferred
    )
      violation("reconnecting did not resume saving");
  };

  const toggleComposition = () => {
    composing = !composing;
    if (!composing && deferred) {
      deferred = false;
      current.coordinator.resumeExternalUpdates();
    }
  };

  for (let step = 0; step < scenario.steps; step += 1) {
    const roll = next();
    if (roll < 0.24) localEdit();
    else if (roll < 0.36) agentEdit();
    else if (roll < 0.62) completeOldest(true);
    else if (roll < 0.72) await scenario.advanceTime(Math.floor(next() * 120));
    else if (roll < 0.76) void current.coordinator.flushNow();
    else if (roll < 0.8) await burst();
    else if (roll < 0.84) rename();
    else if (roll < 0.87) await toggleConnection();
    else if (roll < 0.9) toggleComposition();
    else if (snapshot().conflict !== null) choose();
    else if (snapshot().error !== null) void current.coordinator.retry();
    else if (roll < 0.95) current.coordinator.setConnected(true);
    await settle();
    observe();
  }

  // Drain: reconnect, finish composition and any rename, complete everything
  // without injected failures, and resolve remaining conflicts with a recorded
  // choice until the lane is quiet.
  for (let round = 0; round < 300; round += 1) {
    if (renameRelease !== null) rename();
    connected = true;
    current.coordinator.setConnected(true);
    if (composing) toggleComposition();
    // The watcher eventually reports the last agent write, even if no hint did.
    if (round === 0) current.coordinator.noteFreshnessHint();
    while (pending.length > 0) {
      completeOldest(false);
      await settle();
    }
    await scenario.advanceTime(1_000);
    await settle();
    observe();
    const state = snapshot();
    if (state.conflict !== null) {
      for (const [key, value] of localExpectations) {
        // Shared units may legitimately take a later agent value through a merge.
        if (format.owner(key) === "local" && format.values(state.draftSource).get(key) !== value)
          violation(`conflict lost local ${key}=${String(value)}`);
      }
      choose();
      continue;
    }
    if (state.error !== null) {
      void current.coordinator.retry();
      continue;
    }
    if (pending.length === 0 && !state.pending && !state.reading && renameRelease === null) break;
  }

  const final = snapshot();
  if (final.pending || final.conflict !== null || final.error !== null || pending.length > 0)
    violation("did not settle");
  if (final.draftSource !== disk.source || final.baselineSource !== disk.source)
    violation("settled text differs from disk");
  if (final.baselineRevision !== disk.revision) violation("settled revision differs from disk");
  checkPublished(disk.source, "final disk");
  const written = format.values(disk.source);
  for (const [key, value] of localExpectations) {
    if (format.owner(key) === "local" && written.get(key) !== value)
      violation(`lost local ${key}=${String(value)}`);
  }
  for (const [key, value] of agentExpectations) {
    if (format.owner(key) === "agent" && written.get(key) !== value)
      violation(`lost agent ${key}=${String(value)}`);
  }
  for (const [key, value] of written) {
    if (format.owner(key) !== "shared") continue;
    if (!produced.has(value)) violation(`shared ${key} was never written`);
    const latest = latestShared.get(key);
    if (stats.choices === 0 && latest !== undefined && value !== latest)
      violation(`shared ${key} lost the latest write without a choice`);
  }
  return { violations, stats };
}

/** Sums the per-run counters so a suite can prove each path was exercised. */
export function totalStressStats(results: readonly StressResult[]): StressStats & {
  readonly runsWithoutChoices: number;
} {
  const total = {
    choices: 0,
    merges: 0,
    mergesWithLocalEdits: 0,
    conflicts: 0,
    disconnects: 0,
    renames: 0,
    refusedDuringRename: 0,
    bursts: 0,
    deferrals: 0,
    viewRefusals: 0,
    runsWithoutChoices: 0,
  };
  for (const { stats } of results) {
    for (const key of Object.keys(stats) as (keyof StressStats)[]) total[key] += stats[key];
    if (stats.choices === 0) total.runsWithoutChoices += 1;
  }
  return total;
}
