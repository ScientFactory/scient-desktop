import * as Schema from "effect/Schema";
import { describe, expect, it } from "@effect/vitest";

import { ValidatedConversationImport } from "./ConversationImporter.ts";

const DIGEST = `sha256:${"a".repeat(64)}`;
const BYTES_DIGEST = `sha256:${"c".repeat(64)}`;

const decode = Schema.decodeUnknownSync(ValidatedConversationImport);

const figure = {
  localId: "attachment-1",
  kind: "image",
  name: "figure.png",
  mimeType: "image/png",
  sizeBytes: 12,
  pastedText: false,
  available: true,
};
const notes = {
  localId: "attachment-2",
  kind: "file",
  name: "notes.pdf",
  mimeType: "application/pdf",
  sizeBytes: 40,
  pastedText: false,
  available: false,
};

const snapshot = {
  format: "scient.conversation-snapshot",
  version: 1,
  thread: {
    title: "Export design",
    createdAt: "2026-09-27T14:00:00.000Z",
    updatedAt: "2026-09-27T15:00:00.000Z",
    provider: "codex",
    model: "gpt-5",
  },
  provenance: { _tag: "original" },
  captured: {
    threadId: "thread-on-another-machine",
    snapshotSequence: 42,
    threadSequence: 40,
    capturedAt: "2026-09-27T15:00:01.000Z",
  },
  selection: { workLog: false, reasoning: false, throughMessageId: null },
  messages: [
    {
      n: 1,
      id: "message-1",
      role: "user",
      turnId: null,
      createdAt: "2026-09-27T14:05:00.000Z",
      updatedAt: "2026-09-27T14:05:00.000Z",
      text: "Please investigate",
      attachments: [figure, notes],
    },
  ],
  reasoning: [],
  workLog: [],
  proposedPlans: [],
  questionAnswers: [
    {
      id: "question-1",
      turnId: "turn-1",
      createdAt: "2026-09-27T14:06:00.000Z",
      items: [{ question: "Which figure?", answer: "This one", attachments: [figure] }],
    },
  ],
  omittedRunningTurn: null,
  warnings: [{ _tag: "attachment-unavailable", name: "notes.pdf", messageN: 1 }],
  contentDigest: DIGEST,
};

const stagedFigure = {
  resourceId: "attachment-1",
  kind: "image",
  name: "figure.png",
  mediaType: "image/png",
  byteLength: 12,
  sha256: BYTES_DIGEST,
  pastedText: false,
};

const validated = {
  importId: "cimp_0f8e7d6c-5b4a-4938-8271-605f4e3d2c1b",
  package: {
    format: "scient.conversation-file",
    formatVersion: { major: 1, minor: 0 },
    exporter: { name: "Scient", version: "0.7.0" },
    exportId: "7f3c9a2e41b8",
    exportedAt: "2026-09-28T09:12:00.000Z",
    sourceThreadId: "thread-on-another-machine",
    contentDigest: DIGEST,
    packageSha256: `sha256:${"b".repeat(64)}`,
    packageBytes: 4_096,
  },
  snapshot,
  attachments: [stagedFigure],
  omissions: [
    { _tag: "work-log-excluded" },
    { _tag: "reasoning-excluded" },
    { _tag: "snapshot-warning", warning: snapshot.warnings[0] },
  ],
  warnings: [],
};

const withMessageAttachments = (attachments: ReadonlyArray<object>) => ({
  ...validated,
  snapshot: {
    ...snapshot,
    messages: [{ ...snapshot.messages[0], attachments }],
    questionAnswers: [],
  },
});

describe("validated conversation import", () => {
  it("accepts a package whose staged attachments back exactly its available attachments", () => {
    const input = decode(validated);
    expect(input.attachments.map((attachment) => attachment.resourceId)).toEqual(["attachment-1"]);
  });

  it("requires the package digest to be the snapshot's", () => {
    expect(() =>
      decode({ ...validated, package: { ...validated.package, contentDigest: BYTES_DIGEST } }),
    ).toThrow(/digest/);
  });

  it("refuses installation-local attachment IDs", () => {
    expect(() =>
      decode(withMessageAttachments([{ ...figure, localId: "thread-1-5b8f1c2e" }])),
    ).toThrow(/not a package resource/);
  });

  it("refuses an available attachment without staged bytes", () => {
    expect(() => decode({ ...validated, attachments: [] })).toThrow(/no staged bytes/);
  });

  it("refuses staged bytes for an unavailable attachment", () => {
    expect(() => decode(withMessageAttachments([{ ...figure, available: false }]))).toThrow(
      /Unavailable attachment/,
    );
  });

  it("refuses staged bytes that disagree with the attachment they back", () => {
    for (const change of [
      { name: "other.png" },
      { mediaType: "image/jpeg" },
      { byteLength: 13 },
      { pastedText: true },
    ]) {
      expect(() => decode({ ...validated, attachments: [{ ...stagedFigure, ...change }] })).toThrow(
        /disagrees/,
      );
    }
  });

  it("refuses duplicate and unreferenced staged attachments", () => {
    expect(() => decode({ ...validated, attachments: [stagedFigure, stagedFigure] })).toThrow(
      /staged twice/,
    );
    expect(() =>
      decode({
        ...validated,
        attachments: [stagedFigure, { ...stagedFigure, resourceId: "attachment-3" }],
      }),
    ).toThrow(/not referenced/);
  });

  it("holds staged attachments to the chat attachment media policy", () => {
    const svg = { ...figure, mimeType: "image/svg+xml" };
    expect(() =>
      decode({
        ...withMessageAttachments([svg]),
        attachments: [{ ...stagedFigure, mediaType: "image/svg+xml" }],
      }),
    ).toThrow();
    const oversizedImage = { ...figure, sizeBytes: 10 * 1024 * 1024 + 1 };
    expect(() =>
      decode({
        ...withMessageAttachments([oversizedImage]),
        attachments: [{ ...stagedFigure, byteLength: oversizedImage.sizeBytes }],
      }),
    ).toThrow();
    const other = { ...figure, kind: "other", mimeType: "application/x-unknown" };
    expect(() =>
      decode({
        ...withMessageAttachments([other]),
        attachments: [{ ...stagedFigure, kind: "other", mediaType: "application/x-unknown" }],
      }),
    ).toThrow();
  });
});
