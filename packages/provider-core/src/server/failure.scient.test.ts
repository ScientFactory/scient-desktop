import { assert, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderSessionId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";

import { makeProviderFailure } from "./failure.ts";
import * as ProviderAdapter from "./ProviderAdapter.ts";

it("names what failed beneath a native session-open wrapper, redacted", () => {
  const sessionOpenFailure = {
    _tag: "ProviderSessionOpenError",
    cause: new ProviderAdapter.ProviderAdapterOpenSessionError({
      driver: ProviderDriverKind.make("scient"),
      providerSessionId: ProviderSessionId.make("provider-session:private-id"),
      cause: {
        _tag: "NativeSessionOperationError",
        message: "Bearer open-secret; RPC command get_available_models timed out after 30000 ms.",
        cause: new Error("raw private-detail"),
      },
    }),
  };
  assert.equal(
    makeProviderFailure({ cause: Cause.fail(sessionOpenFailure) }).message,
    "The provider session could not be opened: Bearer [REDACTED]; RPC command get_available_models timed out after 30000 ms. Check that the provider is installed and signed in, then retry the turn.",
  );
});
