// @effect-diagnostics nodeBuiltinImport:off -- the tests copy real files and watch them reach the disk.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { Sha256Digest } from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "@effect/vitest";

import { copyVerified, type CopyDurability } from "./stagedAttachmentCopy.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

function fixture() {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-attachment-copy-"));
  directories.push(root);
  const bytes = new TextEncoder().encode("staged attachment bytes");
  const source = NodePath.join(root, "staged");
  NodeFS.writeFileSync(source, bytes);
  const store = NodePath.join(root, "store");
  return {
    source,
    store,
    destination: NodePath.join(store, "thread-attachment.png"),
    sha256: `sha256:${NodeCrypto.createHash("sha256").update(bytes).digest("hex")}` as Sha256Digest,
    byteLength: bytes.byteLength,
  };
}

/** Records every flush with what the destination held at that moment. */
function recordingDurability(destination: string) {
  const events: Array<string> = [];
  const durability: CopyDurability = {
    syncFile: async (path) => {
      events.push(
        `file ${path === destination ? "destination" : NodePath.extname(path)} (published: ${NodeFS.existsSync(destination)})`,
      );
    },
    syncDirectory: async (directory) => {
      events.push(
        `directory ${NodePath.basename(directory)} (published: ${NodeFS.existsSync(destination)})`,
      );
    },
  };
  return { events, durability };
}

describe("publishing a staged attachment", () => {
  it("flushes the copy before its rename and the folder after it", async () => {
    const input = fixture();
    const { events, durability } = recordingDurability(input.destination);
    const copied = await copyVerified(input, new AbortController().signal, durability);
    expect(copied).toBe("copied");
    expect(events).toEqual(["file .part (published: false)", "directory store (published: true)"]);
    expect(NodeFS.readFileSync(input.destination, "utf8")).toBe("staged attachment bytes");
    expect(NodeFS.readdirSync(input.store)).toEqual(["thread-attachment.png"]);
  });

  it("flushes bytes an earlier attempt already published before reporting them", async () => {
    const input = fixture();
    await copyVerified(input, new AbortController().signal);
    const { events, durability } = recordingDurability(input.destination);
    expect(await copyVerified(input, new AbortController().signal, durability)).toBe("present");
    expect(events).toEqual([
      "file destination (published: true)",
      "directory store (published: true)",
    ]);
  });

  it("publishes nothing, and flushes nothing, when the bytes do not match", async () => {
    const input = fixture();
    const { events, durability } = recordingDurability(input.destination);
    const copied = await copyVerified(
      { ...input, sha256: `sha256:${"0".repeat(64)}` as Sha256Digest },
      new AbortController().signal,
      durability,
    );
    expect(copied).toBe("corrupt");
    expect(events).toEqual([]);
    expect(NodeFS.readdirSync(input.store)).toEqual([]);
  });

  it("flushes through the real disk", async () => {
    const input = fixture();
    expect(await copyVerified(input, new AbortController().signal)).toBe("copied");
    expect(NodeFS.readFileSync(input.destination, "utf8")).toBe("staged attachment bytes");
  });
});
