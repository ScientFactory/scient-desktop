import { createRequire } from "node:module";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { assertSignedMacIdentityDetails } from "./lib/mac-artifact-signature.ts";

const require = createRequire(import.meta.url);
const { SCIENT_APPSNAP_HELPER_IDENTIFIER, SCIENT_MAC_BUNDLE_IDENTIFIER } =
  require("./lib/mac-signing-policy.cjs") as {
    readonly SCIENT_APPSNAP_HELPER_IDENTIFIER: string;
    readonly SCIENT_MAC_BUNDLE_IDENTIFIER: string;
  };
const { createMacSignHook } = require("./sign-mac-app.cjs") as {
  readonly createMacSignHook: (
    signAsync: ReturnType<typeof vi.fn>,
  ) => (
    options: Record<string, unknown>,
    packager: { readonly projectDir: string },
  ) => Promise<void>;
};
const { createStapleMacAppHook } = require("./staple-mac-app.cjs") as {
  readonly createStapleMacAppHook: (
    run: ReturnType<typeof vi.fn>,
  ) => (context: Record<string, unknown>) => Promise<void>;
};

describe("macOS release signing hooks", () => {
  it("assigns AppSnap its stable identifier and minimal entitlements only", async () => {
    const capturedOptions: unknown[] = [];
    const signAsync = vi.fn(async (options: unknown) => {
      capturedOptions.push(options);
    });
    const inheritedOptionsForFile = vi.fn(() => ({
      hardenedRuntime: true,
      entitlements: "/stage/apps/desktop/resources/entitlements.mac.inherit.plist",
    }));

    await createMacSignHook(signAsync)(
      { optionsForFile: inheritedOptionsForFile },
      { projectDir: "/stage" },
    );

    const passedOptions = capturedOptions[0] as
      | { readonly optionsForFile: (filePath: string) => Record<string, unknown> }
      | undefined;
    if (!passedOptions) throw new Error("Signing hook did not invoke osx-sign.");
    expect(passedOptions.optionsForFile("/stage/Scient.app/Contents/MacOS/Scient")).toEqual({
      hardenedRuntime: true,
      entitlements: "/stage/apps/desktop/resources/entitlements.mac.inherit.plist",
    });
    expect(
      passedOptions.optionsForFile("/stage/Scient.app/Contents/Helpers/scient-appsnap-helper"),
    ).toEqual({
      hardenedRuntime: true,
      entitlements: join("/stage", "apps/desktop/resources/entitlements.appsnap.plist"),
      additionalArguments: ["--identifier", SCIENT_APPSNAP_HELPER_IDENTIFIER],
    });
  });

  it("staples and validates the notarized app before artifact packaging", async () => {
    const run = vi.fn();
    await createStapleMacAppHook(run)({
      electronPlatformName: "darwin",
      appOutDir: "/stage/dist/mac-arm64",
      packager: { appInfo: { productFilename: "Scient" } },
    });

    const appPath = "/stage/dist/mac-arm64/Scient.app";
    expect(run).toHaveBeenNthCalledWith(
      1,
      "/usr/bin/xcrun",
      ["stapler", "staple", "--verbose", appPath],
      { stdio: "inherit" },
    );
    expect(run).toHaveBeenNthCalledWith(
      2,
      "/usr/bin/xcrun",
      ["stapler", "validate", "--verbose", appPath],
      { stdio: "inherit" },
    );
  });

  it("rejects identity drift and inherited Electron entitlements", () => {
    const appDetails = [
      `Identifier=${SCIENT_MAC_BUNDLE_IDENTIFIER}`,
      "Authority=Developer ID Application: ScientFactory (TEAM123)",
      "TeamIdentifier=TEAM123",
    ].join("\n");
    const helperDetails = [
      `Identifier=${SCIENT_APPSNAP_HELPER_IDENTIFIER}`,
      "Authority=Developer ID Application: ScientFactory (TEAM123)",
      "TeamIdentifier=TEAM123",
    ].join("\n");

    expect(() =>
      assertSignedMacIdentityDetails({
        appDetails,
        appSnapDetails: helperDetails,
        appSnapEntitlements: '<?xml version="1.0"?><plist><dict/></plist>',
      }),
    ).not.toThrow();
    expect(() =>
      assertSignedMacIdentityDetails({
        appDetails,
        appSnapDetails: helperDetails,
        appSnapEntitlements:
          "<plist><dict><key>com.apple.security.cs.allow-jit</key><true/></dict></plist>",
      }),
    ).toThrow(/forbidden entitlement/);
  });
});
