// @effect-diagnostics nodeBuiltinImport:off -- macOS codesign smoke uses a disposable synthetic app.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { sign as signApplication } from "@electron/osx-sign";
import { expect, it } from "vite-plus/test";

import { conversationPreviewSignOptions } from "./sign-macos.ts";

const extensionSource = process.env.SCIC_PREVIEW_TEST_APPEX;

it.skipIf(!extensionSource)(
  "signs a disposable Quick Look extension with only its dedicated entitlements",
  async () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scic-preview-sign-"));
    const app = NodePath.join(root, "Scient.app");
    const executable = NodePath.join(app, "Contents", "MacOS", "Scient");
    const extension = NodePath.join(
      app,
      "Contents",
      "PlugIns",
      "ScientConversationQuickLook.appex",
    );
    try {
      NodeFS.mkdirSync(NodePath.dirname(executable), { recursive: true });
      NodeFS.mkdirSync(NodePath.dirname(extension), { recursive: true });
      NodeFS.copyFileSync("/usr/bin/true", executable);
      NodeFS.writeFileSync(
        NodePath.join(app, "Contents", "Info.plist"),
        '<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>' +
          "<key>CFBundleIdentifier</key><string>com.scientfactory.scient</string>" +
          "<key>CFBundleExecutable</key><string>Scient</string>" +
          "<key>CFBundlePackageType</key><string>APPL</string>" +
          "</dict></plist>",
      );
      NodeFS.cpSync(extensionSource!, extension, { recursive: true });
      const inheritedEntitlements = NodePath.join(import.meta.dirname, "entitlements.mac.plist");
      expect(NodeFS.readFileSync(inheritedEntitlements, "utf8")).toContain(
        "com.apple.security.cs.allow-jit",
      );
      for (const target of [
        NodePath.join(extension, "Contents", "MacOS", "ScientConversationQuickLook"),
        extension,
      ]) {
        const seeded = NodeChildProcess.spawnSync(
          "codesign",
          ["--force", "--sign", "-", "--entitlements", inheritedEntitlements, target],
          { encoding: "utf8" },
        );
        expect(seeded.status).toBe(0);
      }
      await signApplication({
        ...conversationPreviewSignOptions({
          app,
          platform: "darwin",
          identity: "-",
          identityValidation: false,
          preAutoEntitlements: false,
          optionsForFile: () => ({
            entitlements: inheritedEntitlements,
          }),
        }),
        batchCodesignCalls: true,
      });
      for (const target of [
        extension,
        NodePath.join(extension, "Contents", "MacOS", "ScientConversationQuickLook"),
      ]) {
        const signed = NodeChildProcess.spawnSync(
          "codesign",
          ["-d", "--entitlements", "-", "--xml", target],
          { encoding: "utf8" },
        );
        expect(signed.status).toBe(0);
        const converted = NodeChildProcess.spawnSync(
          "plutil",
          ["-convert", "json", "-o", "-", "-"],
          { encoding: "utf8", input: signed.stdout },
        );
        expect(converted.status).toBe(0);
        expect(JSON.parse(converted.stdout)).toEqual({
          "com.apple.security.app-sandbox": true,
          "com.apple.security.files.user-selected.read-only": true,
        });
      }
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  },
);
