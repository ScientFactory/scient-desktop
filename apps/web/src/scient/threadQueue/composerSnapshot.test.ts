import { describe, expect, it } from "vite-plus/test";
import { ThreadId } from "@t3tools/contracts";
import { createEmptyThreadDraft } from "../../composerDraftStore";
import { buildMessageContext } from "../../lib/composerContextRecords";
import { projectComposerContextForProvider } from "@t3tools/shared/composerContextReferences";
import {
  decodeQueueComposerSnapshot,
  encodeQueueComposerSnapshot,
  migrateQueueComposerContext,
} from "./composerSnapshot";

const legacy = {
  ...createEmptyThreadDraft(),
  prompt: "Explain \uFFFC",
  terminalContexts: [
    {
      id: "terminal",
      threadId: ThreadId.make("thread"),
      terminalId: "default",
      terminalLabel: "Terminal",
      lineStart: 1,
      lineEnd: 1,
      text: "measured result 42",
      createdAt: "2026-09-14T00:00:00.000Z",
    },
  ],
  elementContexts: [
    {
      id: "element",
      pickedAt: "2026-09-14T00:00:00.000Z",
      pageUrl: "https://example.test",
      pageTitle: "Figure",
      tagName: "figure",
      selector: "#plot",
      htmlPreview: "<figure>measured plot</figure>",
      componentName: null,
      source: null,
      styles: "color: red",
    },
  ],
};

describe("queue composer snapshot compatibility", () => {
  it("migrates v1 element selections and terminal placeholders without losing data", () => {
    const decoded = decodeQueueComposerSnapshot(JSON.stringify({ version: 1, ...legacy }));
    expect(decoded.previewAnnotations).toHaveLength(1);
    expect(decoded.prompt).not.toContain("\uFFFC");
    const delivered = projectComposerContextForProvider({
      text: decoded.prompt,
      records: buildMessageContext(decoded)!.records,
    });
    expect(delivered).toContain("measured result 42");
    expect(delivered).toContain("measured plot");
    expect(delivered).not.toContain('unavailable="true"');
    expect(
      migrateQueueComposerContext({ ...decoded, elementContexts: legacy.elementContexts }),
    ).toEqual(decoded);
    expect(JSON.parse(encodeQueueComposerSnapshot(decoded)).version).toBe(2);
    expect(decodeQueueComposerSnapshot(encodeQueueComposerSnapshot(decoded))).toEqual(decoded);
  });
  it("accepts v1 snapshots from the intermediate alignment without elementContexts", () => {
    const { elementContexts: _elements, ...draft } = legacy;
    expect(
      decodeQueueComposerSnapshot(JSON.stringify({ version: 1, ...draft })).terminalContexts,
    ).toEqual(draft.terminalContexts);
  });
  it("rejects malformed legacy selections and unknown versions rather than dropping them", () => {
    expect(() =>
      decodeQueueComposerSnapshot(JSON.stringify({ version: 1, ...legacy, elementContexts: [{}] })),
    ).toThrow();
    expect(() => decodeQueueComposerSnapshot(JSON.stringify({ version: 3, ...legacy }))).toThrow();
  });
});
