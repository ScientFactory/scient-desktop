import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { PROVIDER_SIGN_OUT_METHOD, ProviderSignOutInput } from "./providerSignOutTransport";

describe("provider sign-out transport overlay", () => {
  it("uses a versioned additive method with provider-kind payload validation", () => {
    expect(PROVIDER_SIGN_OUT_METHOD).toBe("scient.provider.signOut.v1");
    expect(Schema.decodeUnknownSync(ProviderSignOutInput)({ provider: "codex" })).toEqual({
      provider: "codex",
    });
    expect(() =>
      Schema.decodeUnknownSync(ProviderSignOutInput)({ provider: "unreviewed-provider" }),
    ).toThrow();
  });
});
