import { ThreadId, type KeepAwakeWork } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { keepsAwake, NO_HOLD, observeWork } from "./keepAwakeHold.ts";

const thread = ThreadId.make("thread");
const other = ThreadId.make("other");
const NOTHING: KeepAwakeWork = { working: [], waiting: [] };
const WORKING: KeepAwakeWork = { working: [thread], waiting: [] };
const WAITING: KeepAwakeWork = { working: [], waiting: [thread] };
const chosen = { chosen: new Map([[thread, null]]), lastWorkAt: null };

describe("a thread's choice", () => {
  it("covers that thread and no other", () => {
    expect(keepsAwake(observeWork(chosen, WORKING, 0), 0)).toBe(true);
    expect(keepsAwake(observeWork(chosen, { working: [other], waiting: [] }, 0), 0)).toBe(false);
  });

  it("holds nothing without a choice", () => {
    expect(observeWork(NO_HOLD, WORKING, 0)).toBe(NO_HOLD);
  });

  it("waits for work on an idle thread", () => {
    expect(observeWork(chosen, NOTHING, 1_000_000).chosen.has(thread)).toBe(true);
  });

  it("stays on while the thread waits, without keeping the computer awake", () => {
    const hold = observeWork(chosen, WAITING, 1_000_000);
    expect(hold.chosen.has(thread)).toBe(true);
    expect(keepsAwake(hold, 1_000_000)).toBe(false);
  });

  it("holds briefly after work ends, then lets go", () => {
    const hold = observeWork(observeWork(chosen, WORKING, 0), WAITING, 15_000);
    expect(keepsAwake(hold, 59_000)).toBe(true);
    expect(keepsAwake(hold, 60_000)).toBe(false);
  });

  it("ends a minute after the work does", () => {
    const working = observeWork(chosen, WORKING, 0);
    expect(observeWork(working, NOTHING, 30_000).chosen.has(thread)).toBe(true);
    expect(observeWork(working, NOTHING, 60_000)).toBe(NO_HOLD);
  });

  it("isn't ended by an update that failed, but stops holding", () => {
    const working = observeWork(chosen, WORKING, 0);
    const unread = observeWork(working, null, 600_000);
    expect(unread.chosen.has(thread)).toBe(true);
    expect(keepsAwake(unread, 600_000)).toBe(false);
  });
});
