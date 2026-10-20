import { describe, expect, it } from "vite-plus/test";
import { KeepAwakeThread, type KeepAwakeObservation } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { observeKeepAwakeSession, selectKeepAwakeSession } from "./keepAwakeSession.ts";

const decodeThread = Schema.decodeUnknownSync(KeepAwakeThread);

const idle: KeepAwakeThread = {
  key: "thread",
  title: "Thread",
  once: false,
  startedAt: null,
};
const observation = (
  observedAt: number,
  unfinished: boolean,
  needsAwake = unfinished,
  latestRunId: string | null = "old-run",
): KeepAwakeObservation => ({
  key: idle.key,
  title: idle.title,
  observedAt,
  latestRunId,
  unfinished,
  needsAwake,
  reason: "Work state",
});

describe("temporary keep-awake batches", () => {
  it("stays armed on an idle thread, including after a reload", () => {
    const selected = selectKeepAwakeSession(idle, "once", observation(1000, false), 1000);
    const restored = decodeThread(JSON.parse(JSON.stringify(selected)));
    const state = observeKeepAwakeSession(restored, observation(500_000, false), undefined, true);
    expect(state.thread).toMatchObject({ once: true, startedAt: null });
    expect(state.completion).toBeUndefined();
  });

  it("arms the next batch when selected during the app default's completion grace", () => {
    const selected = selectKeepAwakeSession(
      { ...idle, startedAt: 1000 },
      "once",
      observation(20_000, false),
      20_000,
    );
    const state = observeKeepAwakeSession(selected, observation(60_000, false), undefined, true);
    expect(state.thread).toMatchObject({ once: true, startedAt: null });
  });

  it("resets after a short next run finishes entirely between polls", () => {
    const selected = selectKeepAwakeSession(idle, "once", observation(1000, false), 1000);
    const first = observeKeepAwakeSession(
      selected,
      observation(15_000, false, false, "new-run"),
      undefined,
      true,
    );
    expect(first.thread.once).toBe(true);
    const done = observeKeepAwakeSession(
      first.thread,
      observation(45_000, false, false, "new-run"),
      first.completion,
      true,
    );
    expect(done.thread).toMatchObject({ once: false, startedAt: null });
  });

  it("includes work added during completion confirmation and follows the default for a later batch", () => {
    const selected = selectKeepAwakeSession(idle, "once", observation(1000, true), 1000);
    const gap = observeKeepAwakeSession(selected, observation(5000, false), undefined, true);
    const continued = observeKeepAwakeSession(
      gap.thread,
      observation(20_000, true),
      gap.completion,
      true,
    );
    expect(continued.thread.once).toBe(true);
    expect(continued.completion).toBeUndefined();
    const finishing = observeKeepAwakeSession(
      continued.thread,
      observation(30_000, false),
      undefined,
      true,
    );
    const done = observeKeepAwakeSession(
      finishing.thread,
      observation(60_000, false),
      finishing.completion,
      true,
    );
    expect(done.thread.once).toBe(false);
    const next = observeKeepAwakeSession(done.thread, observation(70_000, true), undefined, false);
    expect(next.thread).toMatchObject({ once: false, startedAt: null });
  });

  it("keeps paused or held work selected without requiring sleep protection", () => {
    const selected = selectKeepAwakeSession(idle, "once", observation(1000, true), 1000);
    const paused = observeKeepAwakeSession(
      selected,
      observation(60_000, true, false),
      undefined,
      true,
    );
    expect(paused.thread.once).toBe(true);
    expect(paused.completion).toBeUndefined();
    const removed = observeKeepAwakeSession(
      paused.thread,
      observation(90_000, false),
      undefined,
      true,
    );
    const cancelled = observeKeepAwakeSession(
      removed.thread,
      observation(120_000, false),
      removed.completion,
      true,
    );
    expect(cancelled.thread.once).toBe(false);
  });

  it("clears the temporary choice immediately when Use app setting is selected", () => {
    const selected = selectKeepAwakeSession(idle, "once", observation(1000, true), 1000);
    expect(selectKeepAwakeSession(selected, "app", observation(2000, true), 2000).once).toBe(false);
    expect(selectKeepAwakeSession(selected, "once", observation(2000, true), 2000)).toBe(selected);
  });

  it("requires fresh completion confirmation after disconnection and ignores repeated snapshots", () => {
    const selected = selectKeepAwakeSession(idle, "once", observation(1000, true), 1000);
    const first = observeKeepAwakeSession(selected, observation(5000, false), undefined, true);
    const reconnect = observeKeepAwakeSession(
      first.thread,
      observation(200_000, false),
      first.completion,
      true,
    );
    expect(reconnect.thread.once).toBe(true);
    const repeated = observeKeepAwakeSession(
      reconnect.thread,
      observation(200_000, false),
      reconnect.completion,
      true,
    );
    expect(repeated.thread.once).toBe(true);
    const confirmed = observeKeepAwakeSession(
      repeated.thread,
      observation(230_000, false),
      repeated.completion,
      true,
    );
    expect(confirmed.thread.once).toBe(false);
  });
});
