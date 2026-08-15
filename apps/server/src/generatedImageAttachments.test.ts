// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { PROVIDER_SEND_TURN_MAX_IMAGE_BYTES } from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { resolveAttachmentPath } from "./attachmentStore.ts";
import {
  cleanupStaleGeneratedImageAttachmentTemps,
  materializeGeneratedImageAttachment,
} from "./generatedImageAttachments.ts";

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00,
]);
const GIF_BYTES = Buffer.from("GIF89a-generated", "ascii");

describe("generatedImageAttachments", () => {
  const tempDirs: string[] = [];
  const makeTempDir = () => {
    const directory = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "scient-generated-attachment-"),
    );
    tempDirs.push(directory);
    return directory;
  };

  afterEach(() => {
    for (const directory of tempDirs.splice(0)) {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("persists validated bytes with a deterministic replay-safe id", async () => {
    const root = makeTempDir();
    const attachmentsDir = NodePath.join(root, "attachments");
    const sourcePath = NodePath.join(root, "generated.png");
    NodeFS.writeFileSync(sourcePath, PNG_BYTES);

    const first = await materializeGeneratedImageAttachment({
      threadId: "thread-1",
      sourcePath,
      provenanceKey: "provider-thread\0call-1",
      allowedSourceRoots: [root],
      attachmentsDir,
    });
    const replay = await materializeGeneratedImageAttachment({
      threadId: "thread-1",
      sourcePath,
      provenanceKey: "provider-thread\0call-1",
      allowedSourceRoots: [root],
      attachmentsDir,
    });

    expect(replay).toEqual(first);
    expect(first).toMatchObject({
      type: "image",
      name: "generated-image.png",
      mimeType: "image/png",
      sizeBytes: PNG_BYTES.length,
    });
    const persisted = resolveAttachmentPath({ attachmentsDir, attachment: first });
    expect(NodeFS.readFileSync(persisted!)).toEqual(PNG_BYTES);
    expect(NodeFS.readdirSync(attachmentsDir).some((name) => name.includes(".tmp-"))).toBe(false);
  });

  it("recovers its durable copy when the provider source disappeared after restart", async () => {
    const root = makeTempDir();
    const attachmentsDir = NodePath.join(root, "attachments");
    const sourcePath = NodePath.join(root, "generated.png");
    NodeFS.writeFileSync(sourcePath, PNG_BYTES);
    const first = await materializeGeneratedImageAttachment({
      threadId: "thread-1",
      sourcePath,
      provenanceKey: "provider-thread\0call-restart",
      allowedSourceRoots: [root],
      attachmentsDir,
    });
    NodeFS.rmSync(sourcePath);

    await expect(
      materializeGeneratedImageAttachment({
        threadId: "thread-1",
        sourcePath,
        provenanceKey: "provider-thread\0call-restart",
        allowedSourceRoots: [root],
        attachmentsDir,
        allowDurableFallbackWhenSourceUnavailable: true,
      }),
    ).resolves.toEqual(first);
  });

  it("rejects symlink escapes and non-raster content", async () => {
    const root = makeTempDir();
    const outside = makeTempDir();
    const outsidePath = NodePath.join(outside, "outside.png");
    NodeFS.writeFileSync(outsidePath, PNG_BYTES);
    const symlinkPath = NodePath.join(root, "escaped.png");
    NodeFS.symlinkSync(outsidePath, symlinkPath);
    await expect(
      materializeGeneratedImageAttachment({
        threadId: "thread-1",
        sourcePath: symlinkPath,
        provenanceKey: "escape",
        allowedSourceRoots: [root],
        attachmentsDir: NodePath.join(root, "attachments"),
      }),
    ).rejects.toThrow("outside");

    const svgPath = NodePath.join(root, "unsafe.svg");
    NodeFS.writeFileSync(svgPath, '<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>');
    await expect(
      materializeGeneratedImageAttachment({
        threadId: "thread-1",
        sourcePath: svgPath,
        provenanceKey: "svg",
        allowedSourceRoots: [root],
        attachmentsDir: NodePath.join(root, "attachments"),
      }),
    ).rejects.toThrow("unsupported raster");
  });

  it("rejects oversize files and changed deterministic replays", async () => {
    const root = makeTempDir();
    const attachmentsDir = NodePath.join(root, "attachments");
    const oversized = NodePath.join(root, "oversized.png");
    const descriptor = NodeFS.openSync(oversized, "w");
    NodeFS.ftruncateSync(descriptor, PROVIDER_SEND_TURN_MAX_IMAGE_BYTES + 1);
    NodeFS.closeSync(descriptor);
    await expect(
      materializeGeneratedImageAttachment({
        threadId: "thread-1",
        sourcePath: oversized,
        provenanceKey: "oversized",
        allowedSourceRoots: [root],
        attachmentsDir,
      }),
    ).rejects.toThrow("exceeds");

    const sourcePath = NodePath.join(root, "generated.png");
    NodeFS.writeFileSync(sourcePath, PNG_BYTES);
    await materializeGeneratedImageAttachment({
      threadId: "thread-1",
      sourcePath,
      provenanceKey: "same-call",
      allowedSourceRoots: [root],
      attachmentsDir,
    });
    NodeFS.writeFileSync(sourcePath, GIF_BYTES);
    await expect(
      materializeGeneratedImageAttachment({
        threadId: "thread-1",
        sourcePath,
        provenanceKey: "same-call",
        allowedSourceRoots: [root],
        attachmentsDir,
      }),
    ).rejects.toThrow("different persisted bytes or format");
  });

  it("cleans only stale temp files created by this publisher", async () => {
    const root = makeTempDir();
    const attachmentsDir = NodePath.join(root, "attachments");
    NodeFS.mkdirSync(attachmentsDir);
    const stale =
      "thread-1-11111111-1111-4111-8111-111111111111.png.tmp-22222222-2222-4222-8222-222222222222";
    const unrelated = "keep.tmp-33333333-3333-4333-8333-333333333333";
    NodeFS.writeFileSync(NodePath.join(attachmentsDir, stale), PNG_BYTES);
    NodeFS.writeFileSync(NodePath.join(attachmentsDir, unrelated), PNG_BYTES);
    const now = 2_000_000_000_000;
    NodeFS.utimesSync(
      NodePath.join(attachmentsDir, stale),
      (now - 48 * 60 * 60 * 1_000) / 1_000,
      (now - 48 * 60 * 60 * 1_000) / 1_000,
    );

    await expect(cleanupStaleGeneratedImageAttachmentTemps({ attachmentsDir, now })).resolves.toBe(
      1,
    );
    expect(NodeFS.existsSync(NodePath.join(attachmentsDir, stale))).toBe(false);
    expect(NodeFS.existsSync(NodePath.join(attachmentsDir, unrelated))).toBe(true);
  });
});
