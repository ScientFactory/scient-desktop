import * as Schema from "effect/Schema";
import { describe, expect, it } from "@effect/vitest";

import {
  ConversationImportAttemptBinding,
  ConversationImportCompletion,
  conversationImportOmissions,
  conversationImportProvenance,
  sameConversationImportDestination,
  ValidatedConversationImport,
} from "./ConversationImporter.ts";

const DIGEST = `sha256:${"a".repeat(64)}`;
const PACKAGE_DIGEST = `sha256:${"b".repeat(64)}`;
const BYTES_DIGEST = `sha256:${"c".repeat(64)}`;
const IMPORT_ID = "cimp_0f8e7d6c-5b4a-4938-8271-605f4e3d2c1b";

const decode = Schema.decodeUnknownSync(ValidatedConversationImport);
const decodeCompletion = Schema.decodeUnknownSync(ConversationImportCompletion);
const encodeCompletion = Schema.encodeSync(ConversationImportCompletion);
const decodeBinding = Schema.decodeUnknownSync(ConversationImportAttemptBinding);

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

const figureReference = {
  _tag: "attachment",
  id: "r1",
  label: "figure.png",
  attachmentLocalId: "attachment-1",
  image: true,
};

const message = (n: number, turnId: string | null, extra: object = {}) => ({
  n,
  id: `message-${n}`,
  role: n % 2 === 1 ? "user" : "assistant",
  turnId,
  createdAt: "2026-09-27T14:05:00.000Z",
  updatedAt: "2026-09-27T14:05:00.000Z",
  text: `Message ${n}`,
  attachments: [],
  references: [],
  ...extra,
});

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
    message(1, "turn-1", {
      text: "Please investigate [figure.png](scient-ref:r1)",
      attachments: [figure, notes],
      references: [figureReference],
    }),
    message(2, "turn-1"),
    message(3, "turn-2"),
    message(4, "turn-2"),
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
  omittedRunningTurn: { turnId: "turn-3" },
  warnings: [
    { _tag: "running-turn-omitted", turnId: "turn-3" },
    { _tag: "attachment-unavailable", name: "notes.pdf", messageN: 1 },
  ],
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

const packageSummary = {
  format: "scient.conversation-file",
  formatVersion: { major: 1, minor: 0 },
  exporter: { name: "Scient", version: "0.7.0" },
  exportId: "7f3c9a2e41b8",
  exportedAt: "2026-09-28T09:12:00.000Z",
  sourceThreadId: "thread-on-another-machine",
  contentDigest: DIGEST,
  packageSha256: PACKAGE_DIGEST,
  packageBytes: 4_096,
};

const omissionsFor = (value: typeof snapshot) => [
  ...(value.selection.workLog ? [] : [{ _tag: "work-log-excluded" }]),
  ...(value.selection.reasoning ? [] : [{ _tag: "reasoning-excluded" }]),
  ...(value.selection.throughMessageId === null
    ? []
    : [{ _tag: "range-truncated", throughMessageN: value.messages.length }]),
  ...value.warnings.map((warning) => ({ _tag: "snapshot-warning", warning })),
];

const validated = {
  importId: IMPORT_ID,
  package: packageSummary,
  snapshot,
  attachments: [stagedFigure],
  omissions: omissionsFor(snapshot),
  warnings: [
    {
      _tag: "export-warning",
      warning: { code: "attachment-unavailable", message: "notes.pdf was unavailable." },
    },
  ],
};

type SnapshotChanges = { readonly [Key in keyof typeof snapshot]?: unknown };

/** A validated import around a changed snapshot, with omissions recomputed to match it. */
const withSnapshot = (changes: SnapshotChanges) => {
  const changed = { ...snapshot, ...changes } as typeof snapshot;
  return { ...validated, snapshot: changed, omissions: omissionsFor(changed) };
};

type TestAttachment = { readonly name: string; readonly available: boolean };
type TestMessage = { readonly n: number; readonly attachments: ReadonlyArray<TestAttachment> };

/**
 * Messages without question answers, with the warnings their facts require:
 * the omitted running turn and one warning per unavailable attachment.
 */
const withMessages = (messages: ReadonlyArray<TestMessage>) =>
  withSnapshot({
    questionAnswers: [],
    messages,
    warnings: [
      { _tag: "running-turn-omitted", turnId: "turn-3" },
      ...messages.flatMap((entry) =>
        entry.attachments
          .filter((attachment) => !attachment.available)
          .map((attachment) => ({
            _tag: "attachment-unavailable",
            name: attachment.name,
            messageN: entry.n,
          })),
      ),
    ],
  });

describe("validated conversation import", () => {
  it("accepts a consistent package", () => {
    const input = decode(validated);
    expect(input.attachments.map((attachment) => attachment.resourceId)).toEqual(["attachment-1"]);
    expect(input.omissions).toEqual(conversationImportOmissions(input.snapshot));
  });

  describe("package and snapshot identity", () => {
    it("requires the package digest to be the snapshot's", () => {
      expect(() =>
        decode({ ...validated, package: { ...packageSummary, contentDigest: BYTES_DIGEST } }),
      ).toThrow(/digest/);
    });

    it("requires the package's source thread to be the snapshot's thread", () => {
      expect(() =>
        decode({ ...validated, package: { ...packageSummary, sourceThreadId: "thread-other" } }),
      ).toThrow(/source thread/);
    });

    it("refuses unsupported major versions", () => {
      expect(() =>
        decode({
          ...validated,
          package: { ...packageSummary, formatVersion: { major: 2, minor: 0 } },
        }),
      ).toThrow(/not supported/);
    });

    it("requires exactly one version warning for a newer minor version, and none otherwise", () => {
      const newer = { major: 1, minor: 4 };
      const versionWarning = { _tag: "newer-minor-version", formatVersion: newer };
      const newerPackage = { ...packageSummary, formatVersion: newer };
      expect(
        decode({ ...validated, package: newerPackage, warnings: [versionWarning] }).warnings,
      ).toHaveLength(1);
      expect(() => decode({ ...validated, package: newerPackage, warnings: [] })).toThrow(
        /version warning/,
      );
      expect(() => decode({ ...validated, warnings: [versionWarning] })).toThrow(/version warning/);
      expect(() =>
        decode({
          ...validated,
          package: newerPackage,
          warnings: [{ ...versionWarning, formatVersion: { major: 1, minor: 3 } }],
        }),
      ).toThrow(/version warning/);
    });
  });

  describe("omissions", () => {
    it("must be exactly what the snapshot implies", () => {
      expect(() => decode({ ...validated, omissions: [] })).toThrow(/omissions/);
      expect(() => decode({ ...validated, omissions: validated.omissions.toReversed() })).toThrow(
        /omissions/,
      );
      expect(() =>
        decode({
          ...validated,
          omissions: [...validated.omissions, { _tag: "work-log-excluded" }],
        }),
      ).toThrow(/omissions/);
    });

    it("list a truncated range at its last message", () => {
      const input = decode(
        withSnapshot({
          selection: { workLog: false, reasoning: false, throughMessageId: "message-4" },
        }),
      );
      expect(input.omissions).toContainEqual({ _tag: "range-truncated", throughMessageN: 4 });
    });
  });

  describe("snapshot structure", () => {
    it("requires message numbers to run 1..N in order", () => {
      const [first, second, third, fourth] = snapshot.messages;
      expect(() => decode(withSnapshot({ messages: [first!, second!, fourth!, third!] }))).toThrow(
        /numbered/,
      );
      expect(() =>
        decode(withSnapshot({ messages: [first!, { ...second!, n: 3 }, third!, fourth!] })),
      ).toThrow(/numbered/);
    });

    it("requires unique message and reasoning IDs", () => {
      const [first, second, third, fourth] = snapshot.messages;
      expect(() =>
        decode(
          withSnapshot({ messages: [first!, second!, third!, { ...fourth!, id: "message-3" }] }),
        ),
      ).toThrow(/appears twice/);
      expect(() =>
        decode(
          withSnapshot({
            selection: { workLog: false, reasoning: true, throughMessageId: null },
            reasoning: [
              {
                id: "message-2",
                turnId: "turn-1",
                createdAt: "2026-09-27T14:05:00.000Z",
                updatedAt: "2026-09-27T14:05:00.000Z",
                text: "Thinking",
              },
            ],
          }),
        ),
      ).toThrow(/appears twice/);
    });

    it("requires unique plan, question, and work-log IDs", () => {
      expect(() =>
        decode(
          withSnapshot({
            questionAnswers: [snapshot.questionAnswers[0]!, snapshot.questionAnswers[0]!],
          }),
        ),
      ).toThrow(/question question-1 appears twice/);
      const plan = {
        id: "plan-1",
        turnId: "turn-2",
        createdAt: "2026-09-27T14:06:00.000Z",
        updatedAt: "2026-09-27T14:06:00.000Z",
        markdown: "1. Do it",
        implemented: false,
      };
      expect(() => decode(withSnapshot({ proposedPlans: [plan, plan] }))).toThrow(
        /plan plan-1 appears twice/,
      );
      const entry = {
        _tag: "compaction",
        id: "activity-1",
        turnId: "turn-2",
        createdAt: "2026-09-27T14:06:00.000Z",
        title: "Compacted",
      };
      expect(() =>
        decode(
          withSnapshot({
            selection: { workLog: true, reasoning: false, throughMessageId: null },
            workLog: [entry, entry],
          }),
        ),
      ).toThrow(/work-log entry activity-1 appears twice/);
    });

    it("requires each turn's messages to be contiguous", () => {
      const [first, second, third, fourth] = snapshot.messages;
      expect(() =>
        decode(
          withSnapshot({ messages: [first!, second!, third!, { ...fourth!, turnId: "turn-1" }] }),
        ),
      ).toThrow(/split/);
    });

    it("refuses records from the omitted running turn", () => {
      const [first, second, third, fourth] = snapshot.messages;
      expect(() =>
        decode(
          withSnapshot({ messages: [first!, second!, third!, { ...fourth!, turnId: "turn-3" }] }),
        ),
      ).toThrow(/Omitted turn/);
    });

    it("refuses unselected work log and reasoning, and a range that ends early", () => {
      const entry = {
        _tag: "compaction",
        id: "activity-1",
        turnId: "turn-2",
        createdAt: "2026-09-27T14:06:00.000Z",
        title: "Compacted",
      };
      expect(() => decode(withSnapshot({ workLog: [entry] }))).toThrow(/not selected/);
      const reasoning = {
        id: "reasoning-1",
        turnId: "turn-2",
        createdAt: "2026-09-27T14:06:00.000Z",
        updatedAt: "2026-09-27T14:06:00.000Z",
        text: "Thinking",
      };
      expect(() => decode(withSnapshot({ reasoning: [reasoning] }))).toThrow(/not selected/);
      expect(() =>
        decode(
          withSnapshot({
            selection: { workLog: false, reasoning: false, throughMessageId: "message-2" },
          }),
        ),
      ).toThrow(/range/);
    });

    it("requires references to be unique and to name the message's own attachments", () => {
      const [first, ...rest] = snapshot.messages;
      expect(() =>
        decode(
          withSnapshot({
            messages: [{ ...first!, references: [figureReference, figureReference] }, ...rest],
          }),
        ),
      ).toThrow(/Reference r1 appears twice/);
      expect(() =>
        decode(
          withSnapshot({
            messages: [
              {
                ...first!,
                references: [{ ...figureReference, attachmentLocalId: "attachment-9" }],
              },
              ...rest,
            ],
          }),
        ),
      ).toThrow(/names no attachment/);
    });
  });

  describe("snapshot warnings", () => {
    const [runningWarning, notesWarning] = snapshot.warnings;

    it("must report the omitted running turn exactly once", () => {
      expect(() => decode(withSnapshot({ warnings: [notesWarning] }))).toThrow(/running-turn/);
      expect(() =>
        decode(withSnapshot({ warnings: [runningWarning, runningWarning, notesWarning] })),
      ).toThrow(/running-turn/);
      expect(() =>
        decode(
          withSnapshot({
            warnings: [{ _tag: "running-turn-omitted", turnId: "turn-4" }, notesWarning],
          }),
        ),
      ).toThrow(/running-turn/);
      expect(() => decode(withSnapshot({ omittedRunningTurn: null }))).toThrow(/running-turn/);
    });

    it("must report every unavailable attachment, and no other", () => {
      expect(() => decode(withSnapshot({ warnings: [runningWarning] }))).toThrow(
        /attachment warnings/,
      );
      expect(() =>
        decode(
          withSnapshot({
            warnings: [runningWarning, { ...notesWarning, messageN: 2 }],
          }),
        ),
      ).toThrow(/attachment warnings/);
      expect(() =>
        decode(
          withSnapshot({
            warnings: [
              runningWarning,
              notesWarning,
              { _tag: "attachment-unavailable", name: "figure.png", messageN: 1 },
            ],
          }),
        ),
      ).toThrow(/attachment warnings/);
    });

    it("accepts an unsupported-attachment warning for an unavailable attachment", () => {
      const input = decode(
        withSnapshot({
          warnings: [runningWarning, { ...notesWarning, _tag: "attachment-unsupported" }],
        }),
      );
      expect(input.omissions).toContainEqual({
        _tag: "snapshot-warning",
        warning: { _tag: "attachment-unsupported", name: "notes.pdf", messageN: 1 },
      });
    });

    it("reports an unavailable answer attachment without a message number", () => {
      const answer = snapshot.questionAnswers[0]!;
      const answerWith = (available: boolean) => [
        {
          ...answer,
          items: [{ ...answer.items[0]!, attachments: [{ ...notes, available }] }],
        },
      ];
      expect(
        decode(
          withSnapshot({
            questionAnswers: answerWith(false),
            warnings: [...snapshot.warnings, { ...notesWarning, messageN: null }],
          }),
        ).snapshot.questionAnswers,
      ).toHaveLength(1);
      expect(() => decode(withSnapshot({ questionAnswers: answerWith(false) }))).toThrow(
        /attachment warnings/,
      );
    });

    it("passes skipped-records warnings through as omissions", () => {
      const skipped = { _tag: "records-skipped", kind: "activity", count: 2 };
      const input = decode(withSnapshot({ warnings: [...snapshot.warnings, skipped] }));
      expect(input.omissions).toContainEqual({ _tag: "snapshot-warning", warning: skipped });
    });
  });

  describe("typed message context", () => {
    it("refuses an unknown inline reference kind", () => {
      const [first, ...rest] = snapshot.messages;
      expect(() =>
        decode(
          withSnapshot({
            messages: [
              {
                ...first!,
                references: [{ _tag: "unknown-kind", id: "r2", label: "x", payload: {} }],
              },
              ...rest,
            ],
          }),
        ),
      ).toThrow();
    });

    it("drops an open context payload and installation-local reference fields", () => {
      const [first, ...rest] = snapshot.messages;
      const input = decode(
        withSnapshot({
          messages: [
            {
              ...first!,
              context: { version: 1, records: [{ kind: "terminal", secret: "token" }] },
              references: [{ ...figureReference, environmentId: "environment-1", cwd: "/Users/a" }],
            },
            ...rest,
          ],
        }),
      );
      expect(input.snapshot.messages[0]).not.toHaveProperty("context");
      expect(input.snapshot.messages[0]!.references[0]).not.toHaveProperty("environmentId");
      expect(input.snapshot.messages[0]!.references[0]).not.toHaveProperty("cwd");
    });
  });

  describe("attachments", () => {
    it("refuses installation-local attachment IDs", () => {
      expect(() =>
        decode(
          withMessages([
            message(1, null, { attachments: [{ ...figure, localId: "thread-1-5b8f1c2e" }] }),
          ]),
        ),
      ).toThrow(/not a package resource/);
    });

    it("refuses an available attachment without staged bytes", () => {
      expect(() => decode({ ...validated, attachments: [] })).toThrow(/no staged bytes/);
    });

    it("refuses staged bytes for an unavailable attachment", () => {
      expect(() =>
        decode(
          withMessages([message(1, null, { attachments: [{ ...figure, available: false }] })]),
        ),
      ).toThrow(/Unavailable attachment/);
    });

    it("refuses staged bytes that disagree with the attachment they back", () => {
      for (const change of [
        { name: "other.png" },
        { mediaType: "image/jpeg" },
        { byteLength: 13 },
        { pastedText: true },
      ]) {
        expect(() =>
          decode({ ...validated, attachments: [{ ...stagedFigure, ...change }] }),
        ).toThrow(/disagrees/);
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
          ...withMessages([message(1, null, { attachments: [svg] })]),
          attachments: [{ ...stagedFigure, mediaType: "image/svg+xml" }],
        }),
      ).toThrow();
      const oversizedImage = { ...figure, sizeBytes: 10 * 1024 * 1024 + 1 };
      expect(() =>
        decode({
          ...withMessages([message(1, null, { attachments: [oversizedImage] })]),
          attachments: [{ ...stagedFigure, byteLength: oversizedImage.sizeBytes }],
        }),
      ).toThrow();
      const other = { ...figure, kind: "other", mimeType: "application/x-unknown" };
      expect(() =>
        decode({
          ...withMessages([message(1, null, { attachments: [other] })]),
          attachments: [{ ...stagedFigure, kind: "other", mediaType: "application/x-unknown" }],
        }),
      ).toThrow();
    });
  });

  it("records external provenance, and re-imports an exported import", () => {
    const input = decode(validated);
    const provenance = conversationImportProvenance(input.package, "2026-09-28T10:00:00.000Z");
    expect(provenance).toEqual({
      _tag: "import",
      source: "scic",
      exportId: "7f3c9a2e41b8",
      sourceThreadId: "thread-on-another-machine",
      packageDigest: PACKAGE_DIGEST,
      sourceFormat: "scient.conversation-file",
      sourceFormatVersion: 1,
      importedAt: "2026-09-28T10:00:00.000Z",
    });

    // The imported thread, exported again from the second installation, carries
    // that provenance as history and validates as a new import.
    const reExported = {
      ...validated,
      snapshot: {
        ...snapshot,
        provenance,
        captured: { ...snapshot.captured, threadId: "thread-on-second-machine" },
      },
      package: {
        ...packageSummary,
        exportId: "a91b0c2d3e4f",
        sourceThreadId: "thread-on-second-machine",
        packageSha256: `sha256:${"d".repeat(64)}`,
      },
    };
    const again = decode(reExported);
    expect(again.snapshot.provenance).toEqual(provenance);
    expect(conversationImportProvenance(again.package, "2026-09-29T10:00:00.000Z")).toMatchObject({
      exportId: "a91b0c2d3e4f",
      sourceThreadId: "thread-on-second-machine",
    });
  });
});

describe("attempt binding and completion", () => {
  const destination = {
    projectId: "project-1",
    modelSelection: { instanceId: "claude", model: "claude-opus-4" },
    runtimeMode: "approval-required",
    interactionMode: "default",
  };
  const encodedCompletion = {
    packageSha256: PACKAGE_DIGEST,
    result: {
      importId: IMPORT_ID,
      threadId: "thread-2",
      destination,
      messageCount: 4,
      attachmentCount: 1,
    },
    completedAt: "2026-09-28T10:00:00.000Z",
  };
  const completion = decodeCompletion(encodedCompletion);
  const destinationWith = (change: object) =>
    decodeCompletion({
      ...encodedCompletion,
      result: { ...encodedCompletion.result, destination: { ...destination, ...change } },
    }).result.destination;

  it("binds an attempt to the confirm's package digest and destination", () => {
    expect(decodeBinding({ packageSha256: PACKAGE_DIGEST, destination }).destination).toEqual(
      completion.result.destination,
    );
    expect(() => decodeBinding({ destination })).toThrow();
    expect(() => decodeBinding({ packageSha256: PACKAGE_DIGEST })).toThrow();
  });

  it("persists a completion with its digest and the committed destination", () => {
    expect(decodeCompletion(encodeCompletion(completion))).toEqual(completion);
    expect(completion.result.destination.projectId).toBe("project-1");
    const { destination: _omitted, ...resultWithoutDestination } = encodedCompletion.result;
    expect(() =>
      decodeCompletion({ ...encodedCompletion, result: resultWithoutDestination }),
    ).toThrow();
    expect(() => decodeCompletion({ ...encodedCompletion, packageSha256: "sha256:x" })).toThrow();
  });

  it("compares destinations by value", () => {
    expect(
      sameConversationImportDestination(completion.result.destination, destinationWith({})),
    ).toBe(true);
    for (const change of [
      { projectId: "project-2" },
      { runtimeMode: "full-access" },
      { interactionMode: "plan" },
      { modelSelection: { instanceId: "claude", model: "claude-sonnet-4" } },
    ]) {
      expect(
        sameConversationImportDestination(completion.result.destination, destinationWith(change)),
      ).toBe(false);
    }
  });
});
