import { createRequire } from "node:module";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { assertSignedMacIdentityDetails } from "./lib/mac-artifact-signature.ts";

const require = createRequire(import.meta.url);
const { SCIENT_APPSNAP_HELPER_IDENTIFIER, SCIENT_ELECTRON_HELPERS, SCIENT_MAC_BUNDLE_IDENTIFIER } =
  require("./lib/mac-signing-policy.cjs") as {
    readonly SCIENT_APPSNAP_HELPER_IDENTIFIER: string;
    readonly SCIENT_ELECTRON_HELPERS: ReadonlyArray<{ readonly identifier: string }>;
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
const { createNotarizeMacAppHook } = require("./notarize-mac-app.cjs") as {
  readonly createNotarizeMacAppHook: (
    notarize: ReturnType<typeof vi.fn>,
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

  it("delegates signed apps to the controlled notarization workflow", async () => {
    const notarize = vi.fn();
    vi.stubEnv("SCIENT_NOTARIZATION_ARCH", "arm64");
    vi.stubEnv("SCIENT_NOTARIZATION_COMMIT", "abc123");
    vi.stubEnv("SCIENT_NOTARIZATION_EVIDENCE_DIR", "/release");
    vi.stubEnv("SCIENT_NOTARIZATION_VERSION", "0.5.9");
    try {
      await createNotarizeMacAppHook(notarize)({
        electronPlatformName: "darwin",
        appOutDir: "/stage/dist/mac-arm64",
        outDir: "/stage/dist",
        packager: { appInfo: { productFilename: "Scient" } },
      });

      expect(notarize).toHaveBeenCalledWith({
        appPath: "/stage/dist/mac-arm64/Scient.app",
        arch: "arm64",
        commit: "abc123",
        environment: process.env,
        evidenceDirectory: "/release",
        productName: "Scient",
        version: "0.5.9",
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("rejects identity drift and inherited Electron entitlements", () => {
    const appDetails = [
      `Identifier=${SCIENT_MAC_BUNDLE_IDENTIFIER}`,
      "Authority=Developer ID Application: ScientFactory (TEAM123)",
      "TeamIdentifier=TEAM123",
      "Timestamp=21 Jul 2026 at 17:30:00",
      "flags=0x10000(runtime)",
    ].join("\n");
    const helperDetails = [
      `Identifier=${SCIENT_APPSNAP_HELPER_IDENTIFIER}`,
      "Authority=Developer ID Application: ScientFactory (TEAM123)",
      "TeamIdentifier=TEAM123",
      "Timestamp=21 Jul 2026 at 17:30:00",
      "flags=0x10000(runtime)",
    ].join("\n");
    const electronHelpers = SCIENT_ELECTRON_HELPERS.map(({ identifier }) => ({
      identifier,
      details: [
        `Identifier=${identifier}`,
        "Authority=Developer ID Application: ScientFactory (TEAM123)",
        "TeamIdentifier=TEAM123",
        "Timestamp=21 Jul 2026 at 17:30:00",
        "flags=0x10000(runtime)",
      ].join("\n"),
      entitlements: "<plist><dict/></plist>",
    }));

    expect(() =>
      assertSignedMacIdentityDetails({
        appDetails,
        appSnapDetails: helperDetails,
        appSnapEntitlements: '<?xml version="1.0"?><plist><dict/></plist>',
        electronHelpers,
      }),
    ).not.toThrow();
    expect(() =>
      assertSignedMacIdentityDetails({
        appDetails,
        appSnapDetails: helperDetails,
        appSnapEntitlements:
          "<plist><dict><key>com.apple.security.cs.allow-jit</key><true/></dict></plist>",
        electronHelpers,
      }),
    ).toThrow(/forbidden entitlement/);
    const mismatchedElectronHelpers = electronHelpers.slice();
    const firstElectronHelper = mismatchedElectronHelpers[0];
    if (!firstElectronHelper) throw new Error("Expected at least one Electron helper policy.");
    mismatchedElectronHelpers[0] = {
      ...firstElectronHelper,
      details: firstElectronHelper.details.replace(
        "TeamIdentifier=TEAM123",
        "TeamIdentifier=OTHERTEAM",
      ),
    };
    expect(() =>
      assertSignedMacIdentityDetails({
        appDetails,
        appSnapDetails: helperDetails,
        appSnapEntitlements: "<plist><dict/></plist>",
        electronHelpers: mismatchedElectronHelpers,
      }),
    ).toThrow(/Electron helper/);
  });
});
