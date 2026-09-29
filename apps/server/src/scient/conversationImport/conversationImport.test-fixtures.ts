/**
 * Synthetic conversation packages and a staging-shaped lease for importer
 * tests. Nothing here reads live Scient data.
 */
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  AuthOrchestrationOperateScope,
  AuthSessionId,
  ConversationSnapshotV1,
  ProjectId,
  ProviderInstanceId,
  type ConversationImportDestination,
  type EnvironmentSessionPrincipalShape,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  ConversationImportStagingError,
  conversationContentDigest,
  conversationImportOmissions,
  ValidatedConversationImport,
  type ConversationImportLease,
} from "./ConversationImporter.ts";

export const IMPORT_ID = "cimp_0f8e7d6c-5b4a-4938-8271-605f4e3d2c1b";
export const PROJECT_ID = ProjectId.make("import-project");
export const OTHER_PROJECT_ID = ProjectId.make("import-project-2");
export const PROVIDER_ID = ProviderInstanceId.make("codex");

export const destination = (
  overrides: Partial<ConversationImportDestination> = {},
): ConversationImportDestination => ({
  projectId: PROJECT_ID,
  modelSelection: { instanceId: PROVIDER_ID, model: "gpt-5-codex" },
  runtimeMode: "approval-required",
  interactionMode: "default",
  ...overrides,
});

export const principal = (
  scopes: ReadonlyArray<string> = [AuthOrchestrationOperateScope],
): EnvironmentSessionPrincipalShape => ({
  sessionId: AuthSessionId.make("session-1"),
  subject: "tester",
  method: "bearer-access-token",
  scopes: new Set(scopes) as EnvironmentSessionPrincipalShape["scopes"],
});

const sha256 = (bytes: Uint8Array) =>
  `sha256:${NodeCrypto.createHash("sha256").update(bytes).digest("hex")}`;

const at = (seconds: number) =>
  DateTime.formatIso(DateTime.add(DateTime.makeUnsafe("2026-09-27T10:00:00.000Z"), { seconds }));

export interface ImportFixtureOptions {
  /** Completed turns: one user request and one answer each. */
  readonly turns?: number;
  readonly reasoning?: boolean;
  readonly workLog?: boolean;
  /** Tool entries per turn when `workLog` is set; one by default. */
  readonly workLogPerTurn?: number;
  /** Characters of output in each tool entry. */
  readonly workLogOutputChars?: number;
  readonly attachments?: boolean;
  /** Distinguishes packages of separate exports. */
  readonly packageSha256?: string;
}

export interface ImportFixture {
  readonly input: ValidatedConversationImport;
  /** Staged bytes by resource id. */
  readonly resources: ReadonlyMap<string, Uint8Array>;
}

const decodeSnapshot = Schema.decodeUnknownSync(ConversationSnapshotV1);
const decodeValidated = Schema.decodeUnknownSync(ValidatedConversationImport);
const encodeSnapshot = Schema.encodeSync(ConversationSnapshotV1);

/**
 * A validated package: user requests stored without a turn (as Scient stores
 * turn starts), answers in their turn, optional reasoning, work log, plan,
 * answered question, and attachments (one unavailable at export).
 */
export function importFixture(options: ImportFixtureOptions = {}): ImportFixture {
  const turns = options.turns ?? 3;
  const figure = new TextEncoder().encode("figure-bytes");
  const notes = new TextEncoder().encode("pasted notes");
  const resources = new Map<string, Uint8Array>();
  const attachment = (
    localId: string,
    kind: "image" | "file",
    name: string,
    bytes: Uint8Array,
  ) => ({
    localId,
    kind,
    name,
    mimeType: kind === "image" ? "image/png" : "text/plain",
    sizeBytes: bytes.byteLength,
    pastedText: kind === "file",
    available: true,
  });
  const messages = [];
  const reasoning = [];
  const workLog = [];
  for (let turn = 1; turn <= turns; turn += 1) {
    const userN = 2 * turn - 1;
    const withAttachments = options.attachments === true && turn === 1;
    messages.push({
      n: userN,
      id: `src-user-${turn}`,
      role: "user",
      turnId: null,
      createdAt: at(10 * turn),
      updatedAt: at(10 * turn),
      text: withAttachments
        ? `Question ${turn} about [figure.png](scient-ref:r1) and [src/app.ts](scient-ref:r2)`
        : `Question ${turn}`,
      attachments: withAttachments
        ? [
            attachment("attachment-1", "image", "figure.png", figure),
            attachment("attachment-2", "file", "notes.txt", notes),
            {
              localId: "attachment-3",
              kind: "file",
              name: "missing.pdf",
              mimeType: "application/pdf",
              sizeBytes: 40,
              pastedText: false,
              available: false,
            },
          ]
        : [],
      references: withAttachments
        ? [
            {
              _tag: "attachment",
              id: "r1",
              label: "figure.png",
              attachmentLocalId: "attachment-1",
              image: true,
            },
            { _tag: "mention", id: "r2", label: "src/app.ts", path: "src/app.ts" },
          ]
        : [],
    });
    if (options.reasoning === true) {
      reasoning.push({
        id: `src-reasoning-${turn}`,
        turnId: `src-turn-${turn}`,
        createdAt: at(10 * turn + 2),
        updatedAt: at(10 * turn + 2),
        text: `Thinking about ${turn}`,
      });
    }
    if (options.workLog === true) {
      const perTurn = options.workLogPerTurn ?? 1;
      for (let step = 0; step < perTurn; step += 1) {
        workLog.push({
          _tag: "tool",
          id: step === 0 ? `src-tool-${turn}` : `src-tool-${turn}-${step}`,
          turnId: `src-turn-${turn}`,
          createdAt: at(10 * turn + 3),
          title: "Run tests",
          itemType: "command_execution",
          toolName: "Bash",
          status: "completed",
          command: { text: "rm -rf build && npm test", omittedLines: 0, omittedChars: 0 },
          detail: null,
          output: {
            text:
              options.workLogOutputChars === undefined
                ? `ok ${turn}`
                : `ok ${turn} `.padEnd(options.workLogOutputChars, "x"),
            omittedLines: 0,
            omittedChars: 0,
          },
          changedFiles: [],
          omittedChangedFiles: 0,
        });
      }
    }
    messages.push({
      n: userN + 1,
      id: `src-assistant-${turn}`,
      role: "assistant",
      turnId: `src-turn-${turn}`,
      createdAt: at(10 * turn + 5),
      updatedAt: at(10 * turn + 6),
      text: `Answer ${turn}`,
      attachments: [],
      references: [],
    });
  }
  if (options.attachments === true) {
    resources.set("attachment-1", figure);
    resources.set("attachment-2", notes);
  }
  const snapshotWithoutDigest = decodeSnapshot({
    format: "scient.conversation-snapshot",
    version: 1,
    thread: {
      title: "Imported design discussion",
      createdAt: at(0),
      updatedAt: at(10 * turns + 6),
      provider: "codex",
      model: "gpt-5",
    },
    provenance: { _tag: "original" },
    captured: {
      threadId: "thread-on-another-machine",
      snapshotSequence: 99,
      threadSequence: 98,
      capturedAt: at(10 * turns + 7),
    },
    selection: {
      workLog: options.workLog === true,
      reasoning: options.reasoning === true,
      throughMessageId: null,
    },
    messages,
    reasoning,
    workLog,
    proposedPlans: [
      {
        id: "src-plan-1",
        turnId: `src-turn-${turns}`,
        createdAt: at(10 * turns + 4),
        updatedAt: at(10 * turns + 4),
        markdown: "1. Ship it",
        implemented: false,
      },
    ],
    questionAnswers:
      options.attachments === true
        ? [
            {
              id: "src-question-1",
              turnId: "src-turn-1",
              createdAt: at(14),
              items: [
                {
                  question: "Which figure?",
                  answer: "This one",
                  attachments: [attachment("attachment-1", "image", "figure.png", figure)],
                },
              ],
            },
          ]
        : [],
    omittedRunningTurn: null,
    warnings:
      options.attachments === true
        ? [{ _tag: "attachment-unavailable", name: "missing.pdf", messageN: 1 }]
        : [],
    contentDigest: `sha256:${"a".repeat(64)}`,
  });
  const snapshot = decodeSnapshot({
    ...snapshotWithoutDigest,
    contentDigest: conversationContentDigest(snapshotWithoutDigest),
  });
  const staged = [...resources].map(([resourceId, bytes]) => ({
    resourceId,
    kind: resourceId === "attachment-1" ? "image" : "file",
    name: resourceId === "attachment-1" ? "figure.png" : "notes.txt",
    mediaType: resourceId === "attachment-1" ? "image/png" : "text/plain",
    byteLength: bytes.byteLength,
    sha256: sha256(bytes),
    pastedText: resourceId !== "attachment-1",
  }));
  const input = decodeValidated({
    importId: IMPORT_ID,
    package: {
      format: "scient.conversation-file",
      formatVersion: { major: 1, minor: 0 },
      exporter: { name: "Scient", version: "0.7.0" },
      exportId: "7f3c9a2e41b8",
      exportedAt: at(10 * turns + 8),
      sourceThreadId: "thread-on-another-machine",
      contentDigest: snapshot.contentDigest,
      packageSha256: options.packageSha256 ?? `sha256:${"b".repeat(64)}`,
      packageBytes: 4_096,
    },
    snapshot: encodeSnapshot(snapshot),
    attachments: staged,
    omissions: conversationImportOmissions(snapshot),
    warnings: [],
  });
  return { input, resources };
}

export interface TestLeaseControls {
  readonly lease: ConversationImportLease;
  /** Final paths copied so far, in order. */
  readonly copied: Array<string>;
}

/**
 * A lease like staging's: `copyAttachment` verifies and copies the staged
 * bytes through a temporary file and rename. `beforeCopy` injects failures
 * or pauses before a resource is copied.
 */
export function testLease(input: {
  readonly fixture: ImportFixture;
  readonly attemptDirectory: string;
  readonly beforeCopy?: (resourceId: string) => Effect.Effect<void, ConversationImportStagingError>;
}): TestLeaseControls {
  NodeFS.mkdirSync(input.attemptDirectory, { recursive: true });
  const copied: string[] = [];
  const lease: ConversationImportLease = {
    importId: input.fixture.input.importId,
    input: input.fixture.input,
    attemptDirectory: input.attemptDirectory,
    copyAttachment: ({ resourceId, destinationPath }) =>
      (input.beforeCopy?.(resourceId) ?? Effect.void).pipe(
        Effect.andThen(
          Effect.try({
            try: () => {
              const bytes = input.fixture.resources.get(resourceId);
              if (bytes === undefined) throw new Error(`Resource ${resourceId} is not staged.`);
              if (NodeFS.existsSync(destinationPath)) {
                const existing = NodeFS.readFileSync(destinationPath);
                if (Buffer.compare(existing, Buffer.from(bytes)) !== 0) {
                  throw new Error("The destination holds different bytes.");
                }
                return;
              }
              NodeFS.mkdirSync(NodePath.dirname(destinationPath), { recursive: true });
              const temporary = `${destinationPath}.${NodeCrypto.randomUUID()}.tmp`;
              NodeFS.writeFileSync(temporary, bytes);
              NodeFS.renameSync(temporary, destinationPath);
              copied.push(destinationPath);
            },
            catch: (cause) =>
              new ConversationImportStagingError({ reason: "io-failed", detail: String(cause) }),
          }),
        ),
      ),
  };
  return { lease, copied };
}
