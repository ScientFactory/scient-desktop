import { afterEach, describe, expect, it } from "vitest";

import {
  clearNewThreadDraftStaged,
  clearNewThreadLanding,
  isNewThreadDraftStaged,
  isNewThreadLandingPending,
  markNewThreadDraftStaged,
  markNewThreadLanding,
} from "./newThreadLanding";

const THREAD_ID = "thread-new-landing";

afterEach(() => {
  clearNewThreadLanding(THREAD_ID);
  clearNewThreadDraftStaged(THREAD_ID);
});

describe("newThreadLanding", () => {
  it("marks and clears a one-shot draft landing", () => {
    expect(isNewThreadLandingPending(THREAD_ID)).toBe(false);
    markNewThreadLanding(THREAD_ID);
    expect(isNewThreadLandingPending(THREAD_ID)).toBe(true);
    clearNewThreadLanding(THREAD_ID);
    expect(isNewThreadLandingPending(THREAD_ID)).toBe(false);
  });

  it("tracks an uncommitted staged draft independently from its one-shot landing", () => {
    markNewThreadLanding(THREAD_ID);
    markNewThreadDraftStaged(THREAD_ID);

    clearNewThreadLanding(THREAD_ID);
    expect(isNewThreadLandingPending(THREAD_ID)).toBe(false);
    expect(isNewThreadDraftStaged(THREAD_ID)).toBe(true);

    clearNewThreadDraftStaged(THREAD_ID);
    expect(isNewThreadDraftStaged(THREAD_ID)).toBe(false);
  });
});
