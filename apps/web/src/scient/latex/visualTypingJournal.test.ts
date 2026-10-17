// @vitest-environment happy-dom
import "fake-indexeddb/auto";
import { Schema } from "@tiptap/pm/model";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { indexedDbDocumentInputs } from "../markdownEditor/persistence/documentInputCheckpoint";
import { createVisualTypingJournal, prepareVisualTypingRecovery } from "./visualTypingJournal";
import { typingDraftIdentity } from "./visualTyping";

const schema = new Schema({
  nodes: { doc: { content: "paragraph*" }, paragraph: { content: "text*" }, text: {} },
});
const paragraph = (text: string) => schema.node("paragraph", null, schema.text(text));
let sequence = 0;
afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("incremental unconverted writing recovery", () => {
  it("keeps blocks warm after source acceptance and writes only the changed block next time", async () => {
    const key = `journal-test:${++sequence}`,
      journal = createVisualTypingJournal(key);
    const first = paragraph("First"),
      second = paragraph("Second");
    const before = schema.node("doc", null, [first, second]);
    const writes = vi.spyOn(indexedDbDocumentInputs, "replace");
    expect(await journal.checkpoint("First\n\nSecond", before)).toBe(true);
    expect(writes.mock.calls.at(-1)![2]!.changed.size).toBe(2);
    expect(await journal.confirm()).toBe(true);
    const after = schema.node("doc", null, [first, paragraph("Changed")]);
    expect(await journal.checkpoint("First\n\nSecond", after)).toBe(true);
    expect(writes.mock.calls.at(-1)![2]!.changed.size).toBe(1);
    const restored = await indexedDbDocumentInputs.read(`latex-visual:${key}`);
    expect(JSON.parse(restored!.snapshot).content).toEqual(after.toJSON());
    expect(await journal.discard()).toBe(true);
  });
  it("imports durable writing before retiring its journal and preserves a different legacy copy", async () => {
    const key = `journal-test:${++sequence}`,
      journal = createVisualTypingJournal(key);
    const doc = schema.node("doc", null, [paragraph("Retained writing")]);
    expect(await journal.checkpoint("Baseline", doc)).toBe(true);
    const original = await indexedDbDocumentInputs.read(`latex-visual:${key}`);
    const foreign = JSON.stringify({
      baseSource: "Foreign baseline",
      content: schema.node("doc", null, [paragraph("Other window")]).toJSON(),
    });
    localStorage.setItem(`scient:latex-visual-draft:typing:${key}`, foreign);
    await prepareVisualTypingRecovery(key);
    expect(typingDraftIdentity(key)).toBe(foreign);
    expect(localStorage.getItem(`scient:latex-visual-draft:recovered:${key}`)).toContain(
      "Retained writing",
    );
    expect(await indexedDbDocumentInputs.read(`latex-visual:${key}`)).toBeUndefined();
    // The old live writer has lost its token and cannot overwrite a new opener.
    expect(
      await journal.checkpoint("Baseline", schema.node("doc", null, [paragraph("Later")])),
    ).toBe(false);
    expect(original?.checkpoint.pending).toBe(true);
  });
  it("does not reopen accepted input as unsaved work", async () => {
    const key = `journal-test:${++sequence}`,
      journal = createVisualTypingJournal(key);
    const doc = schema.node("doc", null, [paragraph("Saved")]);
    await journal.checkpoint("Saved", doc);
    await journal.confirm();
    await prepareVisualTypingRecovery(key);
    expect(typingDraftIdentity(key)).toBeNull();
    expect(await indexedDbDocumentInputs.read(`latex-visual:${key}`)).toBeUndefined();
  });
  it("releases clean data on close while retaining unconverted writing", async () => {
    const key = `journal-test:${++sequence}`,
      journal = createVisualTypingJournal(key);
    const doc = schema.node("doc", null, [paragraph("Pending")]);
    await journal.checkpoint("Baseline", doc);
    await journal.release();
    expect((await indexedDbDocumentInputs.read(`latex-visual:${key}`))?.checkpoint.pending).toBe(
      true,
    );
    await journal.confirm();
    await journal.release();
    expect(await indexedDbDocumentInputs.read(`latex-visual:${key}`)).toBeUndefined();
  });
});
