import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  DocumentPersistenceCoordinator,
  type DocumentPersistenceFailureKind,
  type DocumentPersistenceReadResult,
} from "./persistenceCoordinator.ts";
import type { DocumentSaveIntent } from "./session.ts";
import { reconcileKeyedLines, type KeyedLinesReconciliation } from "./testing/keyedLines.ts";

/**
 * Randomized interleavings of local typing, agent writes to the same file,
 * ordered saves and reads that succeed, conflict, or fail ambiguously, watcher
 * hints, and explicit conflict choices. Every run checks that no user or agent
 * change is silently lost and that the coordinator settles on the disk bytes.
 */

const LOCAL_KEYS = ["l0", "l1", "l2", "l3"];
const AGENT_KEYS = ["a0", "a1", "a2", "a3"];
const SHARED_KEYS = ["s0", "s1"];
const KEYS = [...LOCAL_KEYS, ...AGENT_KEYS, ...SHARED_KEYS];

function parse(source: string): Map<string, string> {
  return new Map(
    source
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)] as const;
      }),
  );
}

function serialize(values: ReadonlyMap<string, string>): string {
  return KEYS.map((key) => `${key}=${values.get(key) ?? "0"}\n`).join("");
}

function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

type Pending =
  | {
      readonly kind: "write";
      readonly intent: DocumentSaveIntent;
      readonly resolve: (value: { readonly revision: string }) => void;
      readonly reject: (error: unknown) => void;
    }
  | {
      readonly kind: "read";
      readonly resolve: (value: DocumentPersistenceReadResult) => void;
      readonly reject: (error: unknown) => void;
    };

const classifyFailure = (error: unknown): DocumentPersistenceFailureKind =>
  error === "conflict" ? "conflict" : error === "transient" ? "transient" : "terminal";

async function runScenario(seed: number, steps: number) {
  const next = random(seed);
  const pick = <A>(items: readonly A[]) => items[Math.floor(next() * items.length)]!;
  let counter = 0;
  const initial = serialize(new Map());
  let disk = { source: initial, revision: "r0" };
  const pending: Pending[] = [];
  // Values each side set that must survive unless that side's changes were
  // explicitly discarded through a conflict choice.
  let localExpectations = new Map<string, string>();
  let agentExpectations = new Map<string, string>();
  const violations: string[] = [];
  // Shared keys are edited by both sides; conflicts on them are resolved by an
  // explicit choice. Without any choice, the latest write in time must win.
  const latestShared = new Map<string, string>();
  const produced = new Set<string>(["0"]);
  let choices = 0;

  const coordinator = new DocumentPersistenceCoordinator<KeyedLinesReconciliation>({
    source: initial,
    revision: "r0",
    classifyFailure,
    reconcile: reconcileKeyedLines,
    debounceMs: 50,
    maxWaitMs: 200,
    retryDelaysMs: [10, 20, 40],
    write: (intent) =>
      new Promise((resolve, reject) => pending.push({ kind: "write", intent, resolve, reject })),
    read: () => new Promise((resolve, reject) => pending.push({ kind: "read", resolve, reject })),
  });

  // Keeping the local version discards only agent values the draft does not
  // contain; using the disk version discards only local values the disk lacks.
  const keepLocal = (externalRevision: string) => {
    choices += 1;
    const draft = parse(coordinator.getSnapshot().draftSource);
    agentExpectations = new Map([...agentExpectations].filter(([k, v]) => draft.get(k) === v));
    void coordinator.resolveWithLocal(externalRevision);
  };
  const useDisk = () => {
    choices += 1;
    const current = parse(disk.source);
    localExpectations = new Map([...localExpectations].filter(([k, v]) => current.get(k) === v));
    void coordinator.resolveWithDisk();
  };

  const settle = async () => {
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
  };

  const completeOldest = (failures: boolean) => {
    const operation = pending.shift();
    if (!operation) return;
    if (operation.kind === "read") {
      if (failures && next() < 0.1) operation.reject("transient");
      else operation.resolve({ ...disk });
      return;
    }
    const { intent } = operation;
    if (intent.expectedRevision !== disk.revision) {
      operation.reject("conflict");
      return;
    }
    if (failures && next() < 0.08) {
      // The request never reached the file.
      operation.reject("transient");
      return;
    }
    const before = parse(disk.source);
    const written = parse(intent.source);
    for (const [key, value] of agentExpectations) {
      if (AGENT_KEYS.includes(key) && before.get(key) === value && written.get(key) !== value) {
        violations.push(`seed ${seed}: write overwrote agent ${key}=${value}`);
      }
    }
    counter += 1;
    disk = { source: intent.source, revision: `w${counter}` };
    if (failures && next() < 0.08) {
      // Published, but the acknowledgement was lost.
      operation.reject("transient");
      return;
    }
    operation.resolve({ revision: disk.revision });
  };

  for (let step = 0; step < steps; step += 1) {
    const roll = next();
    const snapshot = coordinator.getSnapshot();
    if (roll < 0.28) {
      const values = parse(snapshot.draftSource);
      const key = pick(next() < 0.8 ? LOCAL_KEYS : SHARED_KEYS);
      counter += 1;
      values.set(key, `u${counter}`);
      const source = serialize(values);
      if (coordinator.change(source)) {
        localExpectations.set(key, `u${counter}`);
        produced.add(`u${counter}`);
        if (SHARED_KEYS.includes(key)) latestShared.set(key, `u${counter}`);
        if (coordinator.getSnapshot().draftSource !== source) {
          violations.push(`seed ${seed}: accepted change is not the draft`);
        }
      }
    } else if (roll < 0.43) {
      const values = parse(disk.source);
      const key = pick(next() < 0.8 ? AGENT_KEYS : SHARED_KEYS);
      counter += 1;
      values.set(key, `x${counter}`);
      disk = { source: serialize(values), revision: `x${counter}` };
      agentExpectations.set(key, `x${counter}`);
      produced.add(`x${counter}`);
      if (SHARED_KEYS.includes(key)) latestShared.set(key, `x${counter}`);
      if (next() < 0.6) coordinator.noteFreshnessHint();
    } else if (roll < 0.75) {
      completeOldest(true);
    } else if (roll < 0.88) {
      await vi.advanceTimersByTimeAsync(Math.floor(next() * 120));
    } else if (roll < 0.94) {
      void coordinator.flushNow();
    } else if (snapshot.conflict !== null) {
      if (next() < 0.5) keepLocal(snapshot.conflict.externalRevision);
      else useDisk();
    } else if (snapshot.error !== null) {
      void coordinator.retry();
    }
    await settle();
  }

  // Drain: complete everything without injected failures and resolve any
  // remaining conflict with a recorded choice, until the lane is quiet.
  for (let round = 0; round < 200; round += 1) {
    while (pending.length > 0) {
      completeOldest(false);
      await settle();
    }
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    const snapshot = coordinator.getSnapshot();
    if (snapshot.conflict !== null) {
      for (const [key, value] of localExpectations) {
        // Shared keys may legitimately take a later agent value through a merge.
        if (LOCAL_KEYS.includes(key) && parse(snapshot.draftSource).get(key) !== value) {
          violations.push(`seed ${seed}: conflict lost local ${key}=${value}`);
        }
      }
      if (next() < 0.5) keepLocal(snapshot.conflict.externalRevision);
      else useDisk();
      continue;
    }
    if (snapshot.error !== null) {
      void coordinator.retry();
      continue;
    }
    if (pending.length === 0 && !snapshot.pending && !snapshot.reading) break;
  }

  const final = coordinator.getSnapshot();
  if (final.pending || final.conflict !== null || final.error !== null || pending.length > 0) {
    violations.push(`seed ${seed}: did not settle`);
  }
  if (final.draftSource !== disk.source || final.baselineSource !== disk.source) {
    violations.push(`seed ${seed}: settled text differs from disk`);
  }
  if (final.baselineRevision !== disk.revision) {
    violations.push(`seed ${seed}: settled revision differs from disk`);
  }
  const written = parse(disk.source);
  for (const [key, value] of localExpectations) {
    if (LOCAL_KEYS.includes(key) && written.get(key) !== value) {
      violations.push(`seed ${seed}: lost local ${key}=${value}`);
    }
  }
  for (const [key, value] of agentExpectations) {
    if (AGENT_KEYS.includes(key) && written.get(key) !== value) {
      violations.push(`seed ${seed}: lost agent ${key}=${value}`);
    }
  }
  for (const key of SHARED_KEYS) {
    const value = written.get(key) ?? "0";
    if (!produced.has(value)) violations.push(`seed ${seed}: shared ${key} was never written`);
    const latest = latestShared.get(key);
    if (choices === 0 && latest !== undefined && value !== latest) {
      violations.push(`seed ${seed}: shared ${key} lost the latest write without a choice`);
    }
  }
  return { violations, choices };
}

describe("DocumentPersistenceCoordinator under randomized interleavings", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("never silently loses a local or agent change and settles on the disk bytes", async () => {
    const violations: string[] = [];
    let withoutChoices = 0;
    for (let seed = 1; seed <= 400; seed += 1) {
      const result = await runScenario(seed, 80);
      violations.push(...result.violations);
      if (result.choices === 0) withoutChoices += 1;
    }
    expect(violations).toEqual([]);
    // Both kinds of run must be represented for the checks above to mean anything.
    expect(withoutChoices).toBeGreaterThan(50);
    expect(withoutChoices).toBeLessThan(400);
  });
});
