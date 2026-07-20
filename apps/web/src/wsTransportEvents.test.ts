// FILE: wsTransportEvents.test.ts
// Purpose: Verifies transport-state retention and late-subscriber replay.
// Layer: Web transport event tests

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  addWsTransportStateListener,
  emitWsTransportState,
  getLatestWsTransportState,
} from "./wsTransportEvents";

beforeEach(() => {
  emitWsTransportState("connecting");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("wsTransportEvents", () => {
  it("retains the latest state even when no browser event target exists", () => {
    emitWsTransportState("reconnecting");
    expect(getLatestWsTransportState()).toBe("reconnecting");
  });

  it("replays the latest state to a late subscriber when requested", () => {
    emitWsTransportState("open");
    const listener = vi.fn();

    const unsubscribe = addWsTransportStateListener(listener, { replayLatest: true });

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith("open");
    expect(() => unsubscribe()).not.toThrow();
  });

  it("does not replay unless the caller opts in", () => {
    const listener = vi.fn();
    addWsTransportStateListener(listener);
    expect(listener).not.toHaveBeenCalled();
  });

  it("delivers browser events until unsubscribe and ignores events without detail", () => {
    const eventListeners = new Set<(event: Event) => void>();
    class TestCustomEvent<T> {
      readonly detail: T;
      readonly type: string;

      constructor(type: string, init: { detail: T }) {
        this.type = type;
        this.detail = init.detail;
      }
    }
    vi.stubGlobal("CustomEvent", TestCustomEvent);
    vi.stubGlobal("window", {
      addEventListener: (_type: string, listener: (event: Event) => void) =>
        eventListeners.add(listener),
      dispatchEvent: (event: Event) => {
        for (const listener of eventListeners) listener(event);
        return true;
      },
      removeEventListener: (_type: string, listener: (event: Event) => void) =>
        eventListeners.delete(listener),
    });
    const listener = vi.fn();
    const unsubscribe = addWsTransportStateListener(listener);

    emitWsTransportState("open");
    for (const eventListener of eventListeners) eventListener({} as Event);
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith("open");

    unsubscribe();
    emitWsTransportState("reconnecting");
    expect(listener).toHaveBeenCalledOnce();
  });
});
