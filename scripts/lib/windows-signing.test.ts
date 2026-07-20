import { assert, describe, it } from "@effect/vitest";

import {
  WINDOWS_AZURE_SIGNING_ENV_NAMES,
  resolveWindowsSigningProvider,
} from "./windows-signing.ts";

const azureEnvironment = Object.fromEntries(
  WINDOWS_AZURE_SIGNING_ENV_NAMES.map((name) => [name, `${name}-value`]),
);

describe("resolveWindowsSigningProvider", () => {
  it("returns null when signing is not configured", () => {
    assert.equal(resolveWindowsSigningProvider({}), null);
  });

  it("selects a standard Authenticode certificate", () => {
    assert.equal(
      resolveWindowsSigningProvider({
        WIN_CSC_LINK: "certificate",
        WIN_CSC_KEY_PASSWORD: "password",
      }),
      "certificate",
    );
  });

  it("selects Azure Trusted Signing", () => {
    assert.equal(resolveWindowsSigningProvider(azureEnvironment), "azure");
  });

  it("rejects incomplete or conflicting configuration", () => {
    assert.throws(() => resolveWindowsSigningProvider({ WIN_CSC_LINK: "certificate" }));
    assert.throws(() =>
      resolveWindowsSigningProvider({
        ...azureEnvironment,
        WIN_CSC_LINK: "certificate",
        WIN_CSC_KEY_PASSWORD: "password",
      }),
    );
  });
});
