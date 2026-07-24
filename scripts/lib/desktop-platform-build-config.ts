// FILE: desktop-platform-build-config.ts
// Purpose: Builds platform-specific electron-builder config fragments for desktop artifacts.
// Layer: Release/build helper
// Depends on: Desktop packaging policy and electron-builder config shape.

export const MICROPHONE_USAGE_DESCRIPTION =
  "Scient needs microphone access so you can record voice notes and transcribe them into the chat composer.";
export const MAC_ENTITLEMENTS_PATH = "apps/desktop/resources/entitlements.mac.plist";
export const MAC_INHERITED_ENTITLEMENTS_PATH =
  "apps/desktop/resources/entitlements.mac.inherit.plist";
export const MAC_APPSNAP_HELPER_STAGE_PATH =
  "apps/desktop/native/appsnap/build/scient-appsnap-helper";
export const MAC_ADHOC_SIGN_HOOK_PATH = "scripts/adhoc-sign-mac-app.cjs";
export const MAC_SIGNING_POLICY_PATH = "scripts/lib/mac-signing-policy.cjs";
export const MAC_NOTARIZATION_HOOK_PATH = "scripts/notarize-mac-app.cjs";
export const MAC_APPSNAP_HELPER_ASAR_EXCLUSION = "!apps/desktop/native/appsnap/build/**";
export const MAC_APPSNAP_HELPER_BUNDLE_PATH = "Contents/Helpers/scient-appsnap-helper";
export const WHISPER_RUNTIME_STAGE_PATH = "apps/desktop/native/whisper-runtime";
export const WHISPER_RUNTIME_ASAR_EXCLUSION = `!${WHISPER_RUNTIME_STAGE_PATH}/**`;
export const WHISPER_RUNTIME_RESOURCE_PATH = "whisper-runtime";
export const MAC_WHISPER_RUNTIME_BUNDLE_PATH = "Contents/Resources/whisper-runtime/whisper-server";
export const WINDOWS_INSTALLER_GUID = "368107a8-afe6-5db5-ab3b-d4f331684868";
const MAC_DMG_ICON_PATH = "icon.icns";
export const NODE_PTY_ASAR_UNPACK_GLOBS = ["node_modules/node-pty/**"] as const;

export interface DesktopPlatformBuildConfig {
  readonly afterSign?: string;
  readonly afterPack?: string;
  readonly asarUnpack?: ReadonlyArray<string>;
  readonly deb?: Record<string, unknown>;
  readonly extraFiles?: ReadonlyArray<Record<string, string>>;
  readonly extraResources?: ReadonlyArray<Record<string, string>>;
  readonly files?: ReadonlyArray<string>;
  readonly linux?: Record<string, unknown>;
  readonly mac?: Record<string, unknown>;
  readonly nsis?: Record<string, unknown>;
  readonly win?: Record<string, unknown>;
}

export interface CreateDesktopPlatformBuildConfigInput {
  readonly macNotarizeHookPath?: string;
  readonly macSignHookPath?: string;
  readonly platform: "linux" | "mac" | "win";
  readonly signed?: boolean;
  readonly target: string;
  readonly windowsAzureSignOptions?: Record<string, string>;
}

export interface DesktopNativeBuildHostInput {
  readonly arch: "arm64" | "x64" | "universal";
  readonly hostArch: string;
  readonly hostPlatform: NodeJS.Platform;
  readonly platform: "linux" | "mac" | "win";
}

export function validateDesktopNativeBuildHost(input: DesktopNativeBuildHostInput): string | null {
  if (input.platform === "mac" && input.hostPlatform !== "darwin") {
    return [
      "macOS desktop artifacts include the native Swift AppSnap helper.",
      `Build mac/${input.arch} on macOS so the helper can be compiled and signed.`,
      `Current host is ${input.hostPlatform}/${input.hostArch}.`,
    ].join(" ");
  }
  if (input.platform === "win" && input.arch !== "x64") {
    return "Windows desktop voice runtime packaging currently supports x64 builds only.";
  }
  if (input.platform !== "linux") return null;
  if (input.arch === "universal") {
    return "Linux desktop artifacts support x64 or arm64 builds, not universal builds.";
  }
  if (input.hostPlatform === "linux" && input.hostArch === input.arch) return null;

  return [
    "Linux desktop artifacts include the native node-pty terminal dependency.",
    `Build linux/${input.arch} on a matching Linux host so pty.node and spawn-helper are compiled for Linux.`,
    `Current host is ${input.hostPlatform}/${input.hostArch}.`,
  ].join(" ");
}

export function createDesktopPlatformBuildConfig(
  input: CreateDesktopPlatformBuildConfigInput,
): DesktopPlatformBuildConfig {
  const nativePackaging = {
    asarUnpack: [...NODE_PTY_ASAR_UNPACK_GLOBS],
    extraResources: [
      {
        from: WHISPER_RUNTIME_STAGE_PATH,
        to: WHISPER_RUNTIME_RESOURCE_PATH,
      },
    ],
    files: ["**/*", WHISPER_RUNTIME_ASAR_EXCLUSION],
  };

  if (input.platform === "mac") {
    if (input.signed === true && (!input.macSignHookPath || !input.macNotarizeHookPath)) {
      throw new Error("Signed macOS builds require explicit signing and notarization hooks.");
    }
    const mac = {
      target: input.target === "dmg" ? [input.target, "zip"] : [input.target],
      icon: MAC_DMG_ICON_PATH,
      category: "public.app-category.developer-tools",
      hardenedRuntime: true,
      entitlements: MAC_ENTITLEMENTS_PATH,
      entitlementsInherit: MAC_INHERITED_ENTITLEMENTS_PATH,
      binaries: [MAC_APPSNAP_HELPER_BUNDLE_PATH, MAC_WHISPER_RUNTIME_BUNDLE_PATH],
      ...(input.signed === true
        ? {
            notarize: false,
            sign: input.macSignHookPath,
          }
        : {}),
      // The universal build stages the same pre-lipo'd native executables in both app trees.
      // @electron/universal needs this pattern to preserve those existing fat binaries.
      x64ArchFiles:
        "Contents/{Helpers/scient-appsnap-helper,Resources/whisper-runtime/whisper-server}",
      extendInfo: {
        NSMicrophoneUsageDescription: MICROPHONE_USAGE_DESCRIPTION,
      },
    } satisfies Record<string, unknown>;

    return {
      ...nativePackaging,
      ...(input.signed === true ? { afterSign: input.macNotarizeHookPath } : {}),
      ...(input.signed === true ? {} : { afterPack: MAC_ADHOC_SIGN_HOOK_PATH }),
      files: [
        "**/*",
        MAC_APPSNAP_HELPER_ASAR_EXCLUSION,
        WHISPER_RUNTIME_ASAR_EXCLUSION,
        `!${MAC_ADHOC_SIGN_HOOK_PATH}`,
        `!${MAC_SIGNING_POLICY_PATH}`,
      ],
      extraFiles: [
        {
          from: MAC_APPSNAP_HELPER_STAGE_PATH,
          to: "Helpers/scient-appsnap-helper",
        },
      ],
      mac,
    };
  }

  if (input.platform === "linux") {
    return {
      ...nativePackaging,
      ...(input.target.toLowerCase() === "deb"
        ? {
            deb: {
              packageName: "scient",
              maintainer: "ScientFactory",
              vendor: "ScientFactory",
            },
          }
        : {}),
      linux: {
        target: [input.target],
        executableName: "scient",
        // electron-builder otherwise supplies --no-sandbox to legacy desktop
        // entries. The tracked app-builder patch also removes its runtime
        // fallback so every AppImage launch stays fail-closed.
        executableArgs: [],
        syncDesktopName: true,
        icon: "icon.png",
        category: "Development",
        desktop: {
          entry: {
            StartupWMClass: "scient",
          },
        },
      },
    };
  }

  return {
    ...nativePackaging,
    // Keep the Windows product registration stable while the public app ID changes.
    // This lets NSIS updates replace the existing installation and own its uninstaller.
    nsis: {
      guid: WINDOWS_INSTALLER_GUID,
    },
    win: {
      target: [input.target],
      icon: "icon.ico",
      ...(input.windowsAzureSignOptions ? { azureSignOptions: input.windowsAzureSignOptions } : {}),
    },
  };
}
