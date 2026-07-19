import { afterEach, describe, expect, it } from "vitest";

import {
  clearNewThreadLanding,
  isNewThreadLandingPending,
  markNewThreadLanding,
} from "./newThreadLanding";

const THREAD_ID = "thread-new-landing";

afterEach(() => clearNewThreadLanding(THREAD_ID));

describe("newThreadLanding", () => {
  it("marks and clears a one-shot draft landing", () => {
    expect(isNewThreadLandingPending(THREAD_ID)).toBe(false);
    markNewThreadLanding(THREAD_ID);
    expect(isNewThreadLandingPending(THREAD_ID)).toBe(true);
    clearNewThreadLanding(THREAD_ID);
    expect(isNewThreadLandingPending(THREAD_ID)).toBe(false);
  });
});
