import { describe, expect, it } from "vite-plus/test";

import { releaseOwnedVoiceSession } from "./useVoiceRecorder.ts";

describe("voice recorder session ownership", () => {
  it("does not clear a newer session when stale cleanup finishes", () => {
    const staleSession = {};
    const currentSession = {};
    const slot = { current: currentSession };

    releaseOwnedVoiceSession(slot, staleSession);

    expect(slot.current).toBe(currentSession);
  });

  it("clears the session that still owns the recorder", () => {
    const session = {};
    const slot = { current: session as object | null };

    releaseOwnedVoiceSession(slot, session);

    expect(slot.current).toBeNull();
  });
});
