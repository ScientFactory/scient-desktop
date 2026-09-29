// @effect-diagnostics nodeBuiltinImport:off -- synthetic ZIP fixtures are written to temporary files.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";

import { afterEach, describe, expect, it } from "@effect/vitest";

import { readLocalConversationPreview } from "./localConversationPreview.ts";

const directories: string[] = [];
const json = (value: unknown) => Buffer.from(JSON.stringify(value));
const sha256 = (bytes: Uint8Array) =>
  `sha256:${NodeCrypto.createHash("sha256").update(bytes).digest("hex")}`;
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

function snapshot() {
  const common = {
    format: "scient.conversation-snapshot",
    version: 1,
    thread: {
      title: "Local review",
      createdAt: "2026-09-27T14:00:00.000Z",
      updatedAt: "2026-09-27T14:00:00.000Z",
      provider: null,
      model: null,
    },
    provenance: { _tag: "original" },
    captured: {
      threadId: "thread-1",
      snapshotSequence: 1,
      threadSequence: 1,
      capturedAt: "2026-09-27T14:00:00.000Z",
    },
    selection: { workLog: false, reasoning: false, throughMessageId: null },
    messages: [
      {
        n: 1,
        id: "message-1",
        role: "user",
        turnId: null,
        createdAt: "2026-09-27T14:00:00.000Z",
        updatedAt: "2026-09-27T14:00:00.000Z",
        text: "Please inspect this",
        attachments: [
          {
            localId: "attachment-1",
            kind: "file",
            name: "notes.txt",
            mimeType: "text/plain",
            sizeBytes: 4,
            pastedText: false,
            available: true,
          },
        ],
        references: [],
      },
    ],
    reasoning: [],
    workLog: [],
    proposedPlans: [],
    questionAnswers: [],
    omittedRunningTurn: null,
    warnings: [],
  };
  const { captured: _captured, ...content } = common;
  return { ...common, contentDigest: sha256(Buffer.from(canonical(content))) };
}

interface ZipMember {
  name: string;
  bytes: Buffer;
  method?: number;
  crc?: number;
  external?: number;
}

function zip(members: readonly ZipMember[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const member of members) {
    const name = Buffer.from(member.name);
    const compressed = member.method === 8 ? NodeZlib.deflateRawSync(member.bytes) : member.bytes;
    const crc = member.crc ?? NodeZlib.crc32(member.bytes);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(member.method ?? 0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(member.bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, compressed);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(member.external === undefined ? 20 : (3 << 8) | 20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(member.method ?? 0, 10);
    directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(compressed.length, 20);
    directory.writeUInt32LE(member.bytes.length, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE((member.external ?? 0) >>> 0, 38);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, name);
    offset += local.length + name.length + compressed.length;
  }
  const directoryLength = central.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(members.length, 8);
  end.writeUInt16LE(members.length, 10);
  end.writeUInt32LE(directoryLength, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...central, end]);
}

function packageMembers(overrides?: {
  snapshot?: ReturnType<typeof snapshot>;
  manifest?: (value: Record<string, unknown>) => Record<string, unknown>;
  assetCrc?: number;
}): ZipMember[] {
  const conversation = overrides?.snapshot ?? snapshot();
  const snapshotBytes = json(conversation);
  const markdown = Buffer.from("# Local review\n");
  const asset = Buffer.from("data");
  const assetPath = `attachments/${sha256(asset).slice(7)}-notes.txt`;
  const manifest = {
    format: "scient.conversation-file",
    formatVersion: { major: 1, minor: 0 },
    exporter: { name: "Scient", version: "1.0" },
    exportId: "export-1",
    exportedAt: "2026-09-27T14:00:00.000Z",
    sourceThreadId: "thread-1",
    contentDigest: conversation.contentDigest,
    entries: [
      {
        path: "conversation.json",
        mediaType: "application/json",
        byteLength: snapshotBytes.length,
        sha256: sha256(snapshotBytes),
      },
      {
        path: "conversation.md",
        mediaType: "text/markdown; charset=utf-8",
        byteLength: markdown.length,
        sha256: sha256(markdown),
      },
      { path: assetPath, mediaType: "text/plain", byteLength: asset.length, sha256: sha256(asset) },
    ],
    resources: [
      {
        _tag: "included",
        id: "attachment-1",
        path: assetPath,
        name: "notes.txt",
        kind: "file",
        mediaType: "text/plain",
        byteLength: asset.length,
        sha256: sha256(asset),
      },
    ],
    warnings: [],
  };
  return [
    { name: "mimetype", bytes: Buffer.from("application/vnd.scient.conversation+zip") },
    { name: "manifest.json", bytes: json(overrides?.manifest?.(manifest) ?? manifest), method: 8 },
    { name: "conversation.json", bytes: snapshotBytes, method: 8 },
    { name: "conversation.md", bytes: markdown },
    {
      name: assetPath,
      bytes: asset,
      ...(overrides?.assetCrc === undefined ? {} : { crc: overrides.assetCrc }),
    },
  ];
}

function temporaryFile(bytes: Buffer): string {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-local-preview-"));
  directories.push(directory);
  const path = NodePath.join(directory, "conversation.scic");
  NodeFS.writeFileSync(path, bytes);
  return path;
}

afterEach(() => {
  for (const directory of directories.splice(0))
    NodeFS.rmSync(directory, { recursive: true, force: true });
});

describe("local .scic preview", () => {
  it("reads the authoritative snapshot, attachment names, and descriptor identity without reading assets", async () => {
    const path = temporaryFile(zip(packageMembers({ assetCrc: 1 })));
    const preview = await readLocalConversationPreview(path);
    const stat = NodeFS.statSync(path, { bigint: true });
    expect(preview).toMatchObject({
      title: "Local review",
      messageCount: 1,
      attachmentCount: 1,
      truncated: false,
    });
    expect(preview.messages).toEqual([
      { role: "user", text: "Please inspect this\n[Attachment: notes.txt]" },
    ]);
    expect(preview.identity).toEqual({
      dev: stat.dev.toString(),
      ino: stat.ino.toString(),
      size: stat.size.toString(),
      mtimeNs: stat.mtimeNs.toString(),
    });
  });

  it("keeps attachment names visible when message text is truncated", async () => {
    const long = snapshot();
    long.messages[0]!.text = "A".repeat(25_000);
    const { captured: _captured, contentDigest: _digest, ...content } = long;
    long.contentDigest = sha256(Buffer.from(canonical(content)));
    const preview = await readLocalConversationPreview(
      temporaryFile(zip(packageMembers({ snapshot: long }))),
    );
    expect(preview.truncated).toBe(true);
    expect(preview.messages[0]?.text.endsWith("[Attachment: notes.txt]")).toBe(true);
    expect(preview.messages[0]?.text.length).toBeLessThanOrEqual(20_000);
  });

  it("rejects a changed snapshot digest and malformed manifest", async () => {
    const changed = snapshot();
    changed.messages[0]!.text = "Changed after digest";
    await expect(
      readLocalConversationPreview(temporaryFile(zip(packageMembers({ snapshot: changed })))),
    ).rejects.toMatchObject({ reason: "invalid" });
    await expect(
      readLocalConversationPreview(
        temporaryFile(
          zip(packageMembers({ manifest: (value) => ({ ...value, format: "other" }) })),
        ),
      ),
    ).rejects.toMatchObject({ reason: "invalid" });
  });

  it("rejects path traversal, duplicates, symlinks, and non-regular input", async () => {
    for (const extra of [
      { name: "../outside", bytes: Buffer.alloc(0) },
      { name: "conversation.json", bytes: Buffer.alloc(0) },
      { name: "bad-link", bytes: Buffer.alloc(0), external: 0o120777 << 16 },
    ]) {
      await expect(
        readLocalConversationPreview(temporaryFile(zip([...packageMembers(), extra]))),
      ).rejects.toMatchObject({ reason: "invalid" });
    }
    const original = temporaryFile(zip(packageMembers()));
    const link = NodePath.join(NodePath.dirname(original), "link.scic");
    NodeFS.symlinkSync(original, link);
    await expect(readLocalConversationPreview(link)).rejects.toMatchObject({ reason: "invalid" });
    await expect(readLocalConversationPreview(NodePath.dirname(original))).rejects.toMatchObject({
      reason: "invalid",
    });
  });

  it("reports oversized snapshots without inflating them and honors cancellation", async () => {
    const bigSnapshot = snapshot();
    bigSnapshot.messages[0]!.text = "A".repeat(8 * 1024 * 1024);
    const large = packageMembers({ snapshot: bigSnapshot });
    large[2] = { ...large[2]!, method: 0 };
    const path = temporaryFile(zip(large));
    const stat = NodeFS.statSync(path, { bigint: true });
    await expect(readLocalConversationPreview(path)).rejects.toMatchObject({
      reason: "unsupported-too-large",
      identity: {
        dev: stat.dev.toString(),
        ino: stat.ino.toString(),
        size: stat.size.toString(),
        mtimeNs: stat.mtimeNs.toString(),
      },
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      readLocalConversationPreview(temporaryFile(zip(packageMembers())), controller.signal),
    ).rejects.toMatchObject({ reason: "cancelled" });
  });
});
