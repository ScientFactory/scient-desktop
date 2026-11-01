import { ThreadId, type KeepAwakeWork } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { keepsAwake, NO_HOLD, observeWork } from "./keepAwakeHold.ts";

const thread = ThreadId.make("thread");
const other = ThreadId.make("other");
const NOTHING: KeepAwakeWork = { working: [], waiting: [] };
const WORKING: KeepAwakeWork = { working: [thread], waiting: [] };
const WAITING: KeepAwakeWork = { working: [], waiting: [thread] };
const chosen = { chosen: new Map([[thread, null]]), lastWorkAt: null };

describe("the app setting", () => {
  it("keeps the computer awake only while something works", () => {
    const hold = observeWork(NO_HOLD, WORKING, true, 0);
    expect(keepsAwake(hold, 0)).toBe(true);
    expect(keepsAwake(observeWork(NO_HOLD, NOTHING, true, 0), 0)).toBe(false);
    expect(keepsAwake(observeWork(NO_HOLD, WAITING, true, 0), 0)).toBe(false);
  });

  it("holds briefly after work ends, then lets go", () => {
    const hold = observeWork(observeWork(NO_HOLD, WORKING, true, 0), NOTHING, true, 15_000);
    expect(keepsAwake(hold, 59_000)).toBe(true);
    expect(keepsAwake(hold, 60_000)).toBe(false);
  });

  it("releases if work can no longer be read", () => {
    const hold = observeWork(observeWork(NO_HOLD, WORKING, true, 0), null, true, 60_000);
    expect(keepsAwake(hold, 60_000)).toBe(false);
  });

  it("releases at once when turned off", () => {
    const hold = observeWork(observeWork(NO_HOLD, WORKING, true, 0), null, false, 15_000);
    expect(keepsAwake(hold, 15_000)).toBe(false);
  });
});

describe("a thread's choice", () => {
  it("covers that thread and no other", () => {
    expect(keepsAwake(observeWork(chosen, WORKING, false, 0), 0)).toBe(true);
    expect(keepsAwake(observeWork(chosen, { working: [other], waiting: [] }, false, 0), 0)).toBe(
      false,
    );
  });

  it("waits for work on an idle thread", () => {
    expect(observeWork(chosen, NOTHING, false, 1_000_000).chosen.has(thread)).toBe(true);
  });

  it("stays on while the thread waits, without keeping the computer awake", () => {
    const hold = observeWork(chosen, WAITING, false, 1_000_000);
    expect(hold.chosen.has(thread)).toBe(true);
    expect(keepsAwake(hold, 1_000_000)).toBe(false);
  });

  it("ends a minute after the work does", () => {
    const working = observeWork(chosen, WORKING, false, 0);
    expect(observeWork(working, NOTHING, false, 30_000).chosen.has(thread)).toBe(true);
    expect(observeWork(working, NOTHING, false, 60_000)).toBe(NO_HOLD);
  });

  it("isn't ended by an update that failed", () => {
    const working = observeWork(chosen, WORKING, false, 0);
    expect(observeWork(working, null, false, 600_000).chosen.has(thread)).toBe(true);
  });
});
