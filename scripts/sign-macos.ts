// @effect-diagnostics nodeBuiltinImport:off -- native codesign verification runs only on signed macOS builds.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { sign as signApplication, type SignOptions } from "@electron/osx-sign";

import { MAC_PREVIEW_BUNDLE } from "./lib/conversation-preview-build.ts";

const previewEntitlements = NodePath.resolve(
  import.meta.dirname,
  "../native/conversation-preview/macos/ScientConversationQuickLook.entitlements",
);
const previewExecutableName = "ScientConversationQuickLook";
const exchangeEntitlements = NodePath.resolve(
  import.meta.dirname,
  "../native/file-exchange/entitlements.mac.plist",
);

function exchangePath(app: string): string {
  return NodePath.resolve(app, "Contents/Resources/file-exchange/scient-file-exchange");
}

export function fileExchangeSignOptions(options: SignOptions): SignOptions {
  const helper = exchangePath(options.app);
  if (!NodeFS.existsSync(helper)) {
    if (process.env.SCIENT_FILE_EXCHANGE_EXPECTED === "1")
      throw new Error("Missing required file exchange helper in packaged app.");
    return options;
  }
  const prior = options.optionsForFile;
  return {
    ...options,
    binaries: [...new Set([...(options.binaries ?? []), helper])],
    optionsForFile: (file, context) =>
      NodePath.resolve(file) === helper
        ? { entitlements: exchangeEntitlements, hardenedRuntime: true }
        : (prior?.(file, context) ?? {}),
  };
}

export function verifySignedFileExchange(app: string): void {
  const helper = exchangePath(app);
  if (!NodeFS.existsSync(helper)) {
    if (process.env.SCIENT_FILE_EXCHANGE_EXPECTED === "1")
      throw new Error("Missing required file exchange helper in packaged app.");
    return;
  }
  const result = NodeChildProcess.spawnSync("codesign", ["--verify", "--strict", helper], {
    encoding: "utf8",
    timeout: 10_000,
  });
  if (result.status !== 0 || signingTeam(helper) !== signingTeam(app))
    throw new Error("File exchange helper signature does not match the app.");
}

function previewPaths(app: string): { extension: string; executable: string } {
  const extension = NodePath.resolve(app, "Contents", "PlugIns", MAC_PREVIEW_BUNDLE);
  return {
    extension,
    executable: NodePath.join(extension, "Contents", "MacOS", previewExecutableName),
  };
}

export function conversationPreviewSignOptions(options: SignOptions): SignOptions {
  const { extension, executable } = previewPaths(options.app);
  if (!NodeFS.existsSync(extension)) return options;
  if (!NodeFS.existsSync(executable)) {
    throw new Error(`Missing conversation Quick Look executable: ${executable}`);
  }
  const priorOptionsForFile = options.optionsForFile;
  return {
    ...options,
    binaries: [...new Set([...(options.binaries ?? []), extension])],
    optionsForFile: (filePath, context) => {
      return NodePath.resolve(filePath) === extension || NodePath.resolve(filePath) === executable
        ? { entitlements: previewEntitlements }
        : (priorOptionsForFile?.(filePath, context) ?? {});
    },
  };
}

function verifyPreviewEntitlements(target: string, team: string, bundleId: string): void {
  const signed = NodeChildProcess.spawnSync(
    "codesign",
    ["-d", "--entitlements", "-", "--xml", target],
    { encoding: "utf8" },
  );
  if (signed.status !== 0 || !signed.stdout) {
    throw new Error(`Cannot inspect signed conversation Quick Look entitlements: ${target}`);
  }
  const converted = NodeChildProcess.spawnSync("plutil", ["-convert", "json", "-o", "-", "-"], {
    encoding: "utf8",
    input: signed.stdout,
  });
  if (converted.status !== 0) {
    throw new Error(`Invalid signed conversation Quick Look entitlements: ${target}`);
  }
  let entitlements: unknown;
  try {
    entitlements = JSON.parse(converted.stdout);
  } catch {
    throw new Error(`Invalid signed conversation Quick Look entitlements: ${target}`);
  }
  if (!entitlements || typeof entitlements !== "object" || Array.isArray(entitlements)) {
    throw new Error(`Unsafe signed conversation Quick Look entitlements: ${target}`);
  }
  const values = entitlements as Record<string, unknown>;
  const applicationId = `${team}.${bundleId}`;
  const safe =
    values["com.apple.security.app-sandbox"] === true &&
    values["com.apple.security.files.user-selected.read-only"] === true &&
    Object.entries(values).every(([key, value]) => {
      switch (key) {
        case "com.apple.security.app-sandbox":
        case "com.apple.security.files.user-selected.read-only":
          return value === true;
        case "application-identifier":
        case "com.apple.application-identifier":
          return value === applicationId;
        case "com.apple.developer.team-identifier":
          return value === team;
        case "com.apple.security.get-task-allow":
          return value === false;
        default:
          return false;
      }
    });
  if (!safe) {
    throw new Error(`Unsafe signed conversation Quick Look entitlements: ${target}`);
  }
}

function signingTeam(bundle: string): string {
  const result = NodeChildProcess.spawnSync("codesign", ["-dv", "--verbose=4", bundle], {
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`Cannot inspect macOS signature: ${bundle}`);
  const team = /(?:^|\n)TeamIdentifier=([^\n]+)/u.exec(`${result.stdout}${result.stderr}`)?.[1];
  if (!team || team === "not set") throw new Error(`Missing signing team for ${bundle}`);
  return team;
}

function bundleIdentifier(bundle: string): string {
  return NodeChildProcess.execFileSync(
    "plutil",
    [
      "-extract",
      "CFBundleIdentifier",
      "raw",
      "-o",
      "-",
      NodePath.join(bundle, "Contents", "Info.plist"),
    ],
    { encoding: "utf8" },
  ).trim();
}

export function verifySignedConversationPreview(app: string): void {
  const { extension, executable } = previewPaths(app);
  if (!NodeFS.existsSync(extension)) {
    if (process.env.SCIC_PREVIEW_EXPECTED === "1") {
      throw new Error(`Missing qualified conversation Quick Look extension: ${extension}`);
    }
    return;
  }
  const parentId = bundleIdentifier(app);
  const childId = bundleIdentifier(extension);
  if (
    !childId.startsWith(`${parentId}.`) ||
    (process.env.SCIC_PREVIEW_EXPECTED_BUNDLE_ID &&
      childId !== process.env.SCIC_PREVIEW_EXPECTED_BUNDLE_ID)
  ) {
    throw new Error(
      `Conversation Quick Look bundle ID ${childId} is not the expected child of ${parentId}.`,
    );
  }
  for (const bundle of [executable, extension, app]) {
    const result = NodeChildProcess.spawnSync("codesign", ["--verify", "--strict", bundle], {
      encoding: "utf8",
    });
    if (result.status !== 0)
      throw new Error(`macOS signature verification failed for ${bundle}: ${result.stderr}`);
  }
  const extensionTeam = signingTeam(extension);
  if (extensionTeam !== signingTeam(executable) || extensionTeam !== signingTeam(app)) {
    throw new Error(
      "The conversation Quick Look extension and parent app have different signing teams.",
    );
  }
  verifyPreviewEntitlements(executable, extensionTeam, childId);
  verifyPreviewEntitlements(extension, extensionTeam, childId);
}

/** Sign files with matching options together instead of spawning codesign for each file. */
export default async function sign(options: SignOptions): Promise<void> {
  await signApplication({
    ...fileExchangeSignOptions(conversationPreviewSignOptions(options)),
    batchCodesignCalls: true,
  });
  verifySignedConversationPreview(options.app);
  verifySignedFileExchange(options.app);
}
