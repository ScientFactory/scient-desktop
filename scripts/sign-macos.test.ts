// @effect-diagnostics nodeBuiltinImport:off -- synthetic native signing fixtures use temporary local bundles.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { sign as signApplication, type SignOptions } from "@electron/osx-sign";
import { beforeEach, expect, it, vi } from "vite-plus/test";

import sign, {
  conversationPreviewSignOptions,
  verifySignedConversationPreview,
  fileExchangeSignOptions,
  verifySignedFileExchange,
} from "./sign-macos.ts";

vi.mock("@electron/osx-sign", () => ({ sign: vi.fn() }));
const subprocess = vi.hoisted(() => ({ spawnSync: vi.fn(), execFileSync: vi.fn() }));
vi.mock("node:child_process", () => subprocess);

beforeEach(() => vi.clearAllMocks());

it("signs the exchange helper without Electron entitlements and verifies its team", () => {
  withPreviewApp((app) => {
    const helper = NodePath.join(app, "Contents/Resources/file-exchange/scient-file-exchange");
    NodeFS.mkdirSync(NodePath.dirname(helper), { recursive: true });
    NodeFS.writeFileSync(helper, "native");
    const options = fileExchangeSignOptions({
      app,
      optionsForFile: () => ({ entitlements: "/electron.plist" }),
    });
    expect(options.binaries).toContain(helper);
    expect(options.optionsForFile?.(helper, { platform: "darwin" })).toEqual({
      entitlements: NodePath.resolve(
        import.meta.dirname,
        "../native/file-exchange/entitlements.mac.plist",
      ),
      hardenedRuntime: true,
    });
    expect(options.optionsForFile?.("/other", { platform: "darwin" })).toEqual({
      entitlements: "/electron.plist",
    });
    subprocess.spawnSync.mockImplementation((_command: string, args: string[]) => ({
      status: 0,
      stdout: args[0] === "-dv" ? "TeamIdentifier=TESTTEAM\n" : "",
      stderr: "",
    }));
    verifySignedFileExchange(app);
    subprocess.spawnSync.mockImplementation((_command: string, args: string[]) => ({
      status: 0,
      stdout:
        args[0] === "-dv"
          ? `TeamIdentifier=${args.at(-1) === helper ? "OTHER" : "TESTTEAM"}\n`
          : "",
      stderr: "",
    }));
    expect(() => verifySignedFileExchange(app)).toThrow("signature does not match");
  });
});

it("refuses omission of a helper required by the packaging pipeline", () => {
  const previous = process.env.SCIENT_FILE_EXCHANGE_EXPECTED;
  process.env.SCIENT_FILE_EXCHANGE_EXPECTED = "1";
  try {
    expect(() => fileExchangeSignOptions({ app: "/missing/Scient.app" })).toThrow(
      "Missing required",
    );
    expect(() => verifySignedFileExchange("/missing/Scient.app")).toThrow("Missing required");
  } finally {
    if (previous === undefined) delete process.env.SCIENT_FILE_EXCHANGE_EXPECTED;
    else process.env.SCIENT_FILE_EXCHANGE_EXPECTED = previous;
  }
});

function withPreviewApp(run: (app: string, extension: string, executable: string) => void): void {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scic-sign-preview-"));
  const app = NodePath.join(root, "Scient.app");
  const extension = NodePath.join(app, "Contents", "PlugIns", "ScientConversationQuickLook.appex");
  const executable = NodePath.join(extension, "Contents", "MacOS", "ScientConversationQuickLook");
  NodeFS.mkdirSync(NodePath.dirname(executable), { recursive: true });
  NodeFS.writeFileSync(executable, "");
  try {
    run(app, extension, executable);
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
}

function mockSignedPreview(entitlementsFor: (target: string) => Record<string, unknown>): void {
  subprocess.execFileSync.mockImplementation((_command: string, args: string[]) =>
    args.at(-1)?.includes(".appex")
      ? "com.scientfactory.scient.conversation-preview"
      : "com.scientfactory.scient",
  );
  subprocess.spawnSync.mockImplementation((command: string, args: string[]) => {
    if (command === "plutil") {
      const target = subprocess.spawnSync.mock.calls.at(-2)?.[1]?.at(-1) as string;
      return { status: 0, stdout: JSON.stringify(entitlementsFor(target)), stderr: "" };
    }
    if (args[0] === "-dv") return { status: 0, stdout: "TeamIdentifier=TESTTEAM\n", stderr: "" };
    if (args[0] === "-d") return { status: 0, stdout: "<plist/>", stderr: "" };
    return { status: 0, stdout: "", stderr: "" };
  });
}

it("batches codesign calls without changing existing signing options", async () => {
  const options = {
    app: "/tmp/T3 Code.app",
    identity: "Developer ID Application: T3 Tools, Inc.",
    keychain: "/tmp/t3code.keychain",
    provisioningProfile: "/tmp/t3code.provisionprofile",
    optionsForFile: () => ({
      entitlements: "/tmp/t3code.entitlements.plist",
      hardenedRuntime: true,
    }),
  } satisfies SignOptions;

  await sign(options);

  expect(signApplication).toHaveBeenCalledExactlyOnceWith({
    ...options,
    batchCodesignCalls: true,
  });
});

it("fails closed when a qualified extension is omitted from the app", () => {
  const previous = process.env.SCIC_PREVIEW_EXPECTED;
  process.env.SCIC_PREVIEW_EXPECTED = "1";
  try {
    expect(() => verifySignedConversationPreview("/tmp/scient-preview-missing.app")).toThrow(
      "Missing qualified conversation Quick Look extension",
    );
  } finally {
    if (previous === undefined) delete process.env.SCIC_PREVIEW_EXPECTED;
    else process.env.SCIC_PREVIEW_EXPECTED = previous;
  }
});

it("routes only the Quick Look bundle and executable to sandboxed read-only entitlements", () => {
  withPreviewApp((app, extension, executable) => {
    const prior = vi.fn((_filePath: string, _context: { platform: string }) => ({
      entitlements: "/tmp/electron-jit.plist",
      hardenedRuntime: true,
      additionalArguments: ["--unsafe-argument"],
    }));
    const options = {
      app,
      binaries: ["/tmp/other-binary"],
      optionsForFile: prior,
    } satisfies SignOptions;
    const adapted = conversationPreviewSignOptions(options);
    const previewEntitlements = NodePath.resolve(
      import.meta.dirname,
      "../native/conversation-preview/macos/ScientConversationQuickLook.entitlements",
    );
    expect(adapted.binaries).toEqual(["/tmp/other-binary", extension]);
    const context = { platform: "darwin" } as const;
    expect(adapted.optionsForFile?.(extension, context)).toEqual({
      entitlements: previewEntitlements,
    });
    expect(adapted.optionsForFile?.(executable, context)).toEqual({
      entitlements: previewEntitlements,
    });
    expect(adapted.optionsForFile?.("/tmp/other-binary", context)).toEqual({
      entitlements: "/tmp/electron-jit.plist",
      hardenedRuntime: true,
      additionalArguments: ["--unsafe-argument"],
    });
    expect(prior).toHaveBeenCalledWith("/tmp/other-binary", context);
    expect(options.binaries).toEqual(["/tmp/other-binary"]);
    const relative = conversationPreviewSignOptions({
      ...options,
      app: NodePath.relative(process.cwd(), app),
    });
    expect(relative.binaries).toContain(extension);
    expect(relative.optionsForFile?.(executable, context)?.entitlements).toBe(previewEntitlements);
  });
});

it("accepts matching signing identity metadata but rejects added capabilities", () => {
  withPreviewApp((app, extension, executable) => {
    const safe = {
      "com.apple.security.app-sandbox": true,
      "com.apple.security.files.user-selected.read-only": true,
    };
    mockSignedPreview((target) =>
      target === extension ? { ...safe, "com.apple.security.network.client": true } : safe,
    );
    expect(() => verifySignedConversationPreview(app)).toThrow(
      "Unsafe signed conversation Quick Look entitlements",
    );
    mockSignedPreview((target) =>
      target === executable ? { "com.apple.security.files.user-selected.read-only": true } : safe,
    );
    expect(() => verifySignedConversationPreview(app)).toThrow(
      "Unsafe signed conversation Quick Look entitlements",
    );
    for (const key of [
      "com.apple.security.network.client",
      "com.apple.security.cs.allow-jit",
      "com.apple.security.inherit",
    ]) {
      mockSignedPreview(() => ({ ...safe, [key]: true }));
      expect(() => verifySignedConversationPreview(app)).toThrow(
        "Unsafe signed conversation Quick Look entitlements",
      );
    }
    mockSignedPreview(() => ({ ...safe, "com.apple.security.get-task-allow": true }));
    expect(() => verifySignedConversationPreview(app)).toThrow(
      "Unsafe signed conversation Quick Look entitlements",
    );
    const applicationId = "TESTTEAM.com.scientfactory.scient.conversation-preview";
    mockSignedPreview(() => ({
      ...safe,
      "com.apple.application-identifier": "WRONG." + applicationId,
    }));
    expect(() => verifySignedConversationPreview(app)).toThrow(
      "Unsafe signed conversation Quick Look entitlements",
    );
    mockSignedPreview(() => ({ ...safe, "com.apple.developer.team-identifier": "WRONG" }));
    expect(() => verifySignedConversationPreview(app)).toThrow(
      "Unsafe signed conversation Quick Look entitlements",
    );
    mockSignedPreview(() => ({
      ...safe,
      "application-identifier": applicationId,
      "com.apple.application-identifier": applicationId,
      "com.apple.developer.team-identifier": "TESTTEAM",
      "com.apple.security.get-task-allow": false,
    }));
    expect(() => verifySignedConversationPreview(app)).not.toThrow();
    mockSignedPreview(() => safe);
    expect(() => verifySignedConversationPreview(app)).not.toThrow();
  });
});
