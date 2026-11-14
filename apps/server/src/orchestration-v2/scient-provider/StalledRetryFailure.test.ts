import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import { describe, expect, it } from "vite-plus/test";

import { stalledRetryFailure } from "./StalledRetryFailure.ts";

describe("stalledRetryFailure", () => {
  it("names a stall when the retry carried no code", () => {
    const failure = makeProviderFailure({ message: "overloaded", class: "provider_error" });
    expect(stalledRetryFailure({ ...failure, retryable: true })).toEqual({
      ...failure,
      code: "retry_stalled",
      retryable: false,
    });
  });

  it("keeps a provider code that recovery reads", () => {
    const failure = makeProviderFailure({
      message: "limit",
      code: "subscription_sharing_usage_limit_exceeded",
      class: "usage_limit",
    });
    expect(stalledRetryFailure(failure).code).toBe("subscription_sharing_usage_limit_exceeded");
  });
});
