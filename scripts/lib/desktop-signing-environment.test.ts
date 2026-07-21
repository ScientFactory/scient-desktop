import { assert, describe, it } from "@effect/vitest";

import {
  APPLE_SIGNING_ENV_NAMES,
  DESKTOP_SIGNING_ENV_NAMES,
  isolateDesktopSigningEnvironment,
  WINDOWS_SIGNING_ENV_NAMES,
} from "./desktop-signing-environment.ts";

const signingFixture = Object.fromEntries(
  DESKTOP_SIGNING_ENV_NAMES.map((name) => [name, `${name}-value`]),
);

function assertSigningVariablesRemoved(environment: Record<string, string | undefined>): void {
  for (const name of DESKTOP_SIGNING_ENV_NAMES) {
    assert.notProperty(environment, name);
  }
}

describe("isolateDesktopSigningEnvironment", () => {
  it("retains only Apple credentials for a signed macOS packager", () => {
    const environment = { ...signingFixture, SAFE_VALUE: "preserved" };

    const signingEnvironment = isolateDesktopSigningEnvironment(environment, "mac", true);

    assert.deepEqual(
      Object.keys(signingEnvironment).toSorted(),
      [...APPLE_SIGNING_ENV_NAMES].toSorted(),
    );
    assertSigningVariablesRemoved(environment);
    assert.equal(environment.SAFE_VALUE, "preserved");
  });

  it("retains only Windows credentials for a signed Windows packager", () => {
    const environment = { ...signingFixture };

    const signingEnvironment = isolateDesktopSigningEnvironment(environment, "win", true);

    assert.deepEqual(
      Object.keys(signingEnvironment).toSorted(),
      [...WINDOWS_SIGNING_ENV_NAMES].toSorted(),
    );
    assertSigningVariablesRemoved(environment);
  });

  it("provides no signing credentials to Linux or unsigned packagers", () => {
    for (const [platform, signed] of [
      ["linux", true],
      ["mac", false],
      ["win", false],
    ] as const) {
      const environment = { ...signingFixture };

      assert.deepEqual(isolateDesktopSigningEnvironment(environment, platform, signed), {});
      assertSigningVariablesRemoved(environment);
    }
  });

  it("does not forward empty signing values", () => {
    const environment = Object.fromEntries(APPLE_SIGNING_ENV_NAMES.map((name) => [name, ""]));

    assert.deepEqual(isolateDesktopSigningEnvironment(environment, "mac", true), {});
    assertSigningVariablesRemoved(environment);
  });
});
