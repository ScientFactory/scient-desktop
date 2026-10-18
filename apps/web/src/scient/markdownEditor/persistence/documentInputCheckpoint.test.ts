import "fake-indexeddb/auto";
import { describe, expect, it } from "vite-plus/test";
import {
  indexedDbDocumentInputs,
  type DocumentInputCheckpointUpdate,
} from "./documentInputCheckpoint";
import { indexedDbMarkdownDrafts } from "./markdownDraftCheckpoint";

let sequence = 0;
const key = () => `input-test:${++sequence}`;
const block = (text: string) =>
  JSON.stringify({ type: "paragraph", content: [{ type: "text", text }] });
const initial = (token = "first"): DocumentInputCheckpointUpdate => ({
  checkpoint: { token, envelope: '{"type":"doc"}', blocks: ["a", "b"], bytes: 500, pending: true },
  baseSource: "Original source",
  changed: new Map([
    ["a", block("First")],
    ["b", block("Second")],
  ]),
});

describe("transactional document input checkpoints", () => {
  it("shares the recovery database without changing another document's source checkpoint", async () => {
    const inputKey = key(),
      sourceKey = key();
    const sourceCopy = {
      token: "source-owner",
      baselineSource: "Before",
      baselineRevision: "r1",
      draftSource: "Unsaved source",
      conflict: false,
    };
    expect(await indexedDbMarkdownDrafts.replace(sourceKey, undefined, sourceCopy)).toBe(true);
    await indexedDbDocumentInputs.replace(inputKey, undefined, initial());
    await indexedDbDocumentInputs.replace(inputKey, "first");
    expect(await indexedDbMarkdownDrafts.read(sourceKey)).toEqual(sourceCopy);
    await indexedDbMarkdownDrafts.replace(sourceKey, "source-owner", undefined);
  });
  it("updates only changed blocks and retains the exact baseline and untouched writing", async () => {
    const id = key(),
      before = initial();
    expect(await indexedDbDocumentInputs.replace(id, undefined, before)).toBe(true);
    const next = { ...before.checkpoint, token: "next", blocks: ["a", "c"] };
    expect(
      await indexedDbDocumentInputs.replace(id, "first", {
        checkpoint: next,
        changed: new Map([["c", block("Changed")]]),
      }),
    ).toBe(true);
    const retained = await indexedDbDocumentInputs.read(id);
    expect(retained?.checkpoint).toEqual(next);
    expect(JSON.parse(retained!.snapshot)).toEqual({
      baseSource: "Original source",
      content: {
        type: "doc",
        content: [JSON.parse(block("First")), JSON.parse(block("Changed"))],
      },
    });
    expect(await indexedDbDocumentInputs.replace(id, "next")).toBe(true);
    expect(await indexedDbDocumentInputs.read(id)).toBeUndefined();
  });
  it("refuses a foreign writer and a stale deletion without changing its durable copy", async () => {
    const id = key();
    await indexedDbDocumentInputs.replace(id, undefined, initial());
    const before = await indexedDbDocumentInputs.read(id);
    expect(await indexedDbDocumentInputs.replace(id, undefined, initial("foreign"))).toBe(false);
    expect(await indexedDbDocumentInputs.replace(id, "foreign")).toBe(false);
    expect(await indexedDbDocumentInputs.read(id)).toEqual(before);
    await indexedDbDocumentInputs.replace(id, "first");
  });
  it("rolls back removed blocks and metadata when a replacement lacks one of its blocks", async () => {
    const id = key();
    await indexedDbDocumentInputs.replace(id, undefined, initial());
    const before = await indexedDbDocumentInputs.read(id);
    await expect(
      indexedDbDocumentInputs.replace(id, "first", {
        checkpoint: { ...initial().checkpoint, token: "broken", blocks: ["missing"] },
        changed: new Map(),
        baseSource: "Changed baseline",
      }),
    ).rejects.toBeDefined();
    expect(await indexedDbDocumentInputs.read(id)).toEqual(before);
    await indexedDbDocumentInputs.replace(id, "first");
  });
  it("preserves the previous owner when the next copy exceeds the recovery budget", async () => {
    const id = key();
    await indexedDbDocumentInputs.replace(id, undefined, initial());
    await expect(
      indexedDbDocumentInputs.replace(id, "first", {
        ...initial("large"),
        checkpoint: { ...initial("large").checkpoint, bytes: 5 * 1024 * 1024 },
      }),
    ).rejects.toThrow();
    expect((await indexedDbDocumentInputs.read(id))?.checkpoint.token).toBe("first");
    await indexedDbDocumentInputs.replace(id, "first");
  });
});
