import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { PROVIDER_SEND_TURN_MAX_IMAGE_BYTES } from "@synara/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { resolveAttachmentPath } from "./attachmentStore.ts";
import { materializeGeneratedImageAttachment } from "./generatedImageAttachments.ts";

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00,
]);
const GIF_BYTES = Buffer.from("GIF89a-generated", "ascii");

describe("generatedImageAttachments", () => {
  const tempDirs: string[] = [];
  const makeTempDir = () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "scient-generated-attachment-"));
    tempDirs.push(directory);
    return directory;
  };

  afterEach(() => {
    for (const directory of tempDirs.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("persists a validated image with a deterministic replay-safe attachment id", async () => {
    const root = makeTempDir();
    const attachmentsDir = path.join(root, "attachments");
    const sourcePath = path.join(root, "generated.png");
    fs.writeFileSync(sourcePath, PNG_BYTES);

    const first = await materializeGeneratedImageAttachment({
      threadId: "thread-1",
      sourcePath,
      provenanceKey: "call-1",
      allowedSourceRoots: [root],
      attachmentsDir,
    });
    const replay = await materializeGeneratedImageAttachment({
      threadId: "thread-1",
      sourcePath,
      provenanceKey: "call-1",
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
    const persistedPath = resolveAttachmentPath({
      attachmentsDir,
      attachment: first,
    });
    expect(persistedPath).not.toBeNull();
    expect(fs.readFileSync(persistedPath!)).toEqual(PNG_BYTES);
    expect(fs.readdirSync(attachmentsDir).some((entry) => entry.includes(".tmp-"))).toBe(false);
  });

  it("recovers validated durable bytes when a persisted-recovery source is gone", async () => {
    const root = makeTempDir();
    const attachmentsDir = path.join(root, "attachments");
    const sourcePath = path.join(root, "generated.png");
    fs.writeFileSync(sourcePath, PNG_BYTES);
    const first = await materializeGeneratedImageAttachment({
      threadId: "thread-1",
      sourcePath,
      provenanceKey: "call-restart",
      allowedSourceRoots: [root],
      attachmentsDir,
    });
    const durablePath = resolveAttachmentPath({
      attachmentsDir,
      attachment: first,
    });
    const durableStat = fs.statSync(durablePath!);
    fs.rmSync(sourcePath);

    const recovered = await materializeGeneratedImageAttachment({
      threadId: "thread-1",
      sourcePath,
      provenanceKey: "call-restart",
      allowedSourceRoots: [root],
      attachmentsDir,
      allowDurableFallbackWhenSourceUnavailable: true,
    });

    expect(recovered).toEqual(first);
    expect(fs.readFileSync(durablePath!)).toEqual(PNG_BYTES);
    expect(fs.statSync(durablePath!).mtimeMs).toBe(durableStat.mtimeMs);
  });

  it("rejects a symlink whose real target escapes the authorized root", async () => {
    const allowedRoot = makeTempDir();
    const outsideRoot = makeTempDir();
    const outsidePath = path.join(outsideRoot, "outside.png");
    fs.writeFileSync(outsidePath, PNG_BYTES);
    const symlinkPath = path.join(allowedRoot, "escaped.png");
    fs.symlinkSync(outsidePath, symlinkPath);

    await expect(
      materializeGeneratedImageAttachment({
        threadId: "thread-1",
        sourcePath: symlinkPath,
        provenanceKey: "call-1",
        allowedSourceRoots: [allowedRoot],
        attachmentsDir: path.join(allowedRoot, "attachments"),
      }),
    ).rejects.toThrow("outside the authorized");
  });

  it("rejects SVG and other content without a safe raster signature", async () => {
    const root = makeTempDir();
    const sourcePath = path.join(root, "generated.svg");
    fs.writeFileSync(sourcePath, '<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>');

    await expect(
      materializeGeneratedImageAttachment({
        threadId: "thread-1",
        sourcePath,
        provenanceKey: "call-1",
        allowedSourceRoots: [root],
        attachmentsDir: path.join(root, "attachments"),
      }),
    ).rejects.toThrow("unsupported");
  });

  it("rejects files larger than the chat image limit before reading them", async () => {
    const root = makeTempDir();
    const sourcePath = path.join(root, "oversized.png");
    const descriptor = fs.openSync(sourcePath, "w");
    fs.ftruncateSync(descriptor, PROVIDER_SEND_TURN_MAX_IMAGE_BYTES + 1);
    fs.closeSync(descriptor);

    await expect(
      materializeGeneratedImageAttachment({
        threadId: "thread-1",
        sourcePath,
        provenanceKey: "call-1",
        allowedSourceRoots: [root],
        attachmentsDir: path.join(root, "attachments"),
      }),
    ).rejects.toThrow("exceeds");
  });

  it("fails closed when a deterministic source path is replayed with different bytes", async () => {
    const root = makeTempDir();
    const sourcePath = path.join(root, "generated.png");
    const attachmentsDir = path.join(root, "attachments");
    fs.writeFileSync(sourcePath, PNG_BYTES);
    await materializeGeneratedImageAttachment({
      threadId: "thread-1",
      sourcePath,
      provenanceKey: "call-1",
      allowedSourceRoots: [root],
      attachmentsDir,
    });
    fs.writeFileSync(sourcePath, Buffer.concat([PNG_BYTES, Buffer.from([0x01])]));

    await expect(
      materializeGeneratedImageAttachment({
        threadId: "thread-1",
        sourcePath,
        provenanceKey: "call-1",
        allowedSourceRoots: [root],
        attachmentsDir,
      }),
    ).rejects.toThrow("different persisted bytes");
  });

  it("fails closed when the same provenance replays with a different image format", async () => {
    const root = makeTempDir();
    const pngPath = path.join(root, "generated.png");
    const gifPath = path.join(root, "generated.gif");
    const attachmentsDir = path.join(root, "attachments");
    fs.writeFileSync(pngPath, PNG_BYTES);
    fs.writeFileSync(gifPath, GIF_BYTES);
    await materializeGeneratedImageAttachment({
      threadId: "thread-1",
      sourcePath: pngPath,
      provenanceKey: "call-cross-format",
      allowedSourceRoots: [root],
      attachmentsDir,
    });

    await expect(
      materializeGeneratedImageAttachment({
        threadId: "thread-1",
        sourcePath: gifPath,
        provenanceKey: "call-cross-format",
        allowedSourceRoots: [root],
        attachmentsDir,
      }),
    ).rejects.toThrow("different persisted bytes or format");
    expect(fs.readdirSync(attachmentsDir)).toHaveLength(1);
    expect(fs.readdirSync(attachmentsDir)[0]).toMatch(/\.png$/);
  });

  it("allows a later generation with a different call id to reuse the same provider path", async () => {
    const root = makeTempDir();
    const sourcePath = path.join(root, "generated.png");
    const attachmentsDir = path.join(root, "attachments");
    fs.writeFileSync(sourcePath, PNG_BYTES);
    const first = await materializeGeneratedImageAttachment({
      threadId: "thread-1",
      sourcePath,
      provenanceKey: "call-1",
      allowedSourceRoots: [root],
      attachmentsDir,
    });
    fs.writeFileSync(sourcePath, Buffer.concat([PNG_BYTES, Buffer.from([0x01])]));
    const second = await materializeGeneratedImageAttachment({
      threadId: "thread-1",
      sourcePath,
      provenanceKey: "call-2",
      allowedSourceRoots: [root],
      attachmentsDir,
    });

    expect(second.id).not.toBe(first.id);
    expect(fs.readdirSync(attachmentsDir)).toHaveLength(2);
  });
});
