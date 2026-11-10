import {
  CONVERSATION_SNAPSHOT_FORMAT,
  MessageId,
  ThreadId,
  TurnId,
  type ConversationSnapshotV1,
} from "@t3tools/contracts";
import type { CloudConversation } from "@scientfactory/scient-cloud/api";

const turn = TurnId.make("turn-1");
const at = (seconds: number) => new Date(Date.UTC(2026, 10, 10, 9, 0, seconds)).toISOString();

export const FIXTURE_IMAGE_SHA256 = "a".repeat(64);
const FIXTURE_RENDER_SHA256 = "b".repeat(64);

const snapshot: ConversationSnapshotV1 = {
  format: CONVERSATION_SNAPSHOT_FORMAT,
  version: 1,
  thread: {
    title: "Fit the decay model",
    createdAt: at(0),
    updatedAt: at(30),
    provider: "codex",
    model: "gpt-5.5",
  },
  provenance: { _tag: "original" },
  captured: {
    threadId: ThreadId.make("thread-1"),
    snapshotSequence: 10,
    threadSequence: 10,
    capturedAt: at(40),
  },
  selection: { workLog: true, reasoning: false, throughMessageId: null },
  messages: [
    {
      n: 1,
      id: MessageId.make("user-1"),
      role: "user",
      turnId: null,
      createdAt: at(0),
      updatedAt: at(0),
      text: "Fit the model in [model.py](scient-ref:r1) to the attached plot.",
      attachments: [
        {
          localId: "attachment-1",
          kind: "image",
          name: "decay.png",
          mimeType: "image/png",
          sizeBytes: 68,
          pastedText: false,
          available: true,
        },
      ],
      references: [{ _tag: "mention", id: "r1", label: "model.py", path: "src/model.py" }],
    },
    {
      n: 2,
      id: MessageId.make("assistant-1"),
      role: "assistant",
      turnId: turn,
      createdAt: at(20),
      updatedAt: at(28),
      text: "The half-life is $t_{1/2} = \\ln 2 / \\lambda$. See [the fit](src/fit.py:12).",
      attachments: [],
      references: [],
    },
  ],
  reasoning: [],
  workLog: [
    {
      _tag: "tool",
      id: "work-1",
      turnId: turn,
      createdAt: at(5),
      title: "Ran python fit.py",
      itemType: "command_execution",
      toolName: null,
      status: "completed",
      command: { text: "python fit.py", omittedLines: 0, omittedChars: 0 },
      detail: null,
      output: { text: "lambda = 0.0123", omittedLines: 0, omittedChars: 0 },
      changedFiles: [],
      omittedChangedFiles: 0,
    },
    {
      _tag: "tool",
      id: "work-2",
      turnId: turn,
      createdAt: at(10),
      title: "Edited src/fit.py",
      itemType: "file_change",
      toolName: null,
      status: "completed",
      command: null,
      detail: null,
      output: null,
      changedFiles: ["src/fit.py"],
      omittedChangedFiles: 0,
    },
  ],
  proposedPlans: [],
  questionAnswers: [],
  omittedRunningTurn: null,
  warnings: [],
  contentDigest: `sha256:${"c".repeat(64)}`,
};

export const fixtureConversation: CloudConversation = {
  snapshot,
  sidecar: {
    answers: [
      {
        messageId: MessageId.make("assistant-1"),
        provider: "claudeAgent",
        model: "claude-opus-5-5",
      },
    ],
    repository: { webUrl: "https://github.com/example/decay", commit: "0123456789abcdef" },
    attachments: [{ localId: "attachment-1", sha256: FIXTURE_IMAGE_SHA256, bytes: 68 }],
    renders: [
      {
        id: "render-1",
        messageId: MessageId.make("assistant-1"),
        name: "Decay chart",
        sha256: FIXTURE_RENDER_SHA256,
        bytes: 40,
      },
    ],
  },
};

/** A 1×1 PNG. */
export const FIXTURE_PNG = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  ),
  (char) => char.charCodeAt(0),
);
