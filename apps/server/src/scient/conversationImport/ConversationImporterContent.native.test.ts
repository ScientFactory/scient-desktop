// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { MessageId, ThreadId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { ConversationImportCommit } from "./ConversationImportCommit.ts";
import { ProjectionStoreV2 } from "../../orchestration-v2/ProjectionStore.ts";
import { ConversationImporter, type ConversationImportLease } from "./ConversationImporter.ts";
import { readConversationImportJournal } from "./ConversationImportJournal.ts";
import {
  buildConversationImportCommand,
  mintConversationImportIds,
  idsCoverImport,
} from "./conversationImportPlan.ts";
import {
  destination,
  IMPORT_ID,
  importFixture,
  principal,
  PROJECT_ID,
  PROVIDER_ID,
  testLease,
  type ImportFixture,
} from "./conversationImport.test-fixtures.ts";
import {
  createNativeProjects as createProjects,
  nativeImportTestLayer as importTestLayer,
  type NativeImportTestControls as ImportTestControls,
} from "./conversationImport.native-test-harness.ts";
import {
  buildConversationDocument,
  buildConversationSnapshot,
  writeConversationMarkdown,
} from "@scientfactory/conversation";
import { conversationSnapshotProjection } from "../conversationExport/conversationSnapshotProjection.ts";

const attemptDirectory = (name = "attempt") =>
  Effect.map(ServerConfig, (config) =>
    NodePath.join(config.stateDir, "conversation-imports", IMPORT_ID, name),
  );

const readThread = (threadId: ThreadId) =>
  Effect.flatMap(ProjectionStoreV2, (store) => store.getThreadProjection(threadId)).pipe(
    Effect.map((projection) => conversationSnapshotProjection(projection, "/tmp/import-project")),
  );

const buildNativePlan = (input: Parameters<typeof buildConversationImportCommand>[0]) =>
  Effect.gen(function* () {
    const plan = buildConversationImportCommand(input);
    yield* (yield* ConversationImportCommit).dispatch(plan);
    const projection = yield* (yield* ProjectionStoreV2).getThreadProjection(plan.threadId);
    assert.strictEqual(projection.thread.historyOrigin, "conversation_import");
    assert.deepStrictEqual(projection.runs, []);
    assert.deepStrictEqual(projection.runtimeRequests, []);
    assert.deepStrictEqual(projection.providerSessions, []);
    assert.isTrue(projection.nodes.every((node) => !node.countsForRun && node.runId === null));
    return plan;
  });

const importRequest = (overrides: Parameters<typeof destination>[0] = {}) => ({
  destination: destination(overrides),
  principal: principal(),
});

const leaseFor = (
  fixture: ImportFixture,
  options: {
    readonly name?: string;
    readonly beforeCopy?: Parameters<typeof testLease>[0]["beforeCopy"];
  } = {},
) =>
  Effect.map(attemptDirectory(options.name), (directory) =>
    testLease({
      fixture,
      attemptDirectory: directory,
      ...(options.beforeCopy === undefined ? {} : { beforeCopy: options.beforeCopy }),
    }),
  );

/**
 * Every test runs against a fresh engine, database, and state directory, on a
 * clock set after the fixtures' history (the test clock otherwise starts in
 * 1970, which would date every fixture after the import).
 */
const withImporter = <A, E, R>(effect: Effect.Effect<A, E, R>, controls?: ImportTestControls) =>
  TestClock.setTime(Date.parse("2026-09-28T09:30:00.000Z")).pipe(
    Effect.andThen(createProjects),
    Effect.andThen(effect),
    Effect.provide(importTestLayer(controls)),
  );

const importOnce = (lease: ConversationImportLease, request = importRequest()) =>
  Effect.flatMap(ConversationImporter, (importer) => importer.importConversation(lease, request));

const journalOf = (directory: string) =>
  readConversationImportJournal(directory).pipe(Effect.map(Option.getOrThrow));

describe("native imported content", () => {
  it.effect("preserves omissions from an already-imported source", () =>
    withImporter(
      Effect.gen(function* () {
        const fixture = importFixture();
        const input: typeof fixture.input = {
          ...fixture.input,
          snapshot: {
            ...fixture.input.snapshot,
            provenance: {
              _tag: "import",
              source: "scic",
              exportId: "previous-export",
              sourceThreadId: "previous-thread",
              packageDigest: `sha256:${"a".repeat(64)}`,
              sourceFormat: "scient.conversation-file",
              sourceFormatVersion: 1,
              importedAt: "2026-09-27T10:00:00.000Z",
              omissions: [{ _tag: "range-truncated", throughMessageN: 2 }],
            },
          },
        };
        const ids = yield* mintConversationImportIds(input);
        const command = yield* buildNativePlan({
          validated: input,
          ids,
          destination: destination(),
          importedAt: "2026-09-28T10:00:00.000Z",
        });
        assert.deepInclude(command.origin.omissions, {
          _tag: "range-truncated",
          throughMessageN: 2,
        });
      }),
    ),
  );

  it.effect("adds up the gaps of an already-imported source and of this file", () =>
    withImporter(
      Effect.gen(function* () {
        const fixture = importFixture({ attachments: true });
        const input: typeof fixture.input = {
          ...fixture.input,
          snapshot: {
            ...fixture.input.snapshot,
            provenance: {
              _tag: "import",
              source: "scic",
              exportId: "previous-export",
              sourceThreadId: "previous-thread",
              packageDigest: `sha256:${"a".repeat(64)}`,
              sourceFormat: "scient.conversation-file",
              sourceFormatVersion: 1,
              importedAt: "2026-09-27T10:00:00.000Z",
              omissions: [
                { _tag: "attachments-unavailable", count: 2 },
                { _tag: "records-skipped", count: 4 },
              ],
            },
          },
          omissions: [
            ...fixture.input.omissions,
            {
              _tag: "snapshot-warning",
              warning: { _tag: "records-skipped", kind: "activity", count: 3 },
            },
          ],
        };
        const ids = yield* mintConversationImportIds(input);
        const command = yield* buildNativePlan({
          validated: input,
          ids,
          destination: destination(),
          importedAt: "2026-09-28T10:00:00.000Z",
        });
        assert.deepInclude(command.origin.omissions, { _tag: "attachments-unavailable", count: 3 });
        assert.deepInclude(command.origin.omissions, { _tag: "records-skipped", count: 7 });
      }),
    ),
  );

  it.effect("counts an unavailable answer attachment once, not again on its folded message", () =>
    withImporter(
      Effect.gen(function* () {
        const fixture = importFixture({ turns: 1, attachments: true });
        const source = fixture.input.snapshot;
        const gone = {
          localId: "attachment-4",
          kind: "file" as const,
          name: "gone.csv",
          mimeType: "text/csv",
          sizeBytes: 10,
          pastedText: false,
          available: false,
        };
        const answer = source.questionAnswers[0]!;
        const warnings = [
          ...source.warnings,
          { _tag: "attachment-unavailable" as const, name: "gone.csv", messageN: 2 },
          { _tag: "attachment-unavailable" as const, name: "gone.csv", messageN: null },
        ];
        const input: typeof fixture.input = {
          ...fixture.input,
          snapshot: {
            ...source,
            messages: [
              source.messages[0]!,
              {
                ...source.messages[0]!,
                n: 2,
                id: MessageId.make(`async-answer:${answer.id}`),
                text: "This one",
                attachments: [gone],
                references: [],
                createdAt: answer.createdAt,
                updatedAt: answer.createdAt,
              },
              { ...source.messages[1]!, n: 3 },
            ],
            questionAnswers: [{ ...answer, items: [{ ...answer.items[0]!, attachments: [gone] }] }],
            warnings,
          },
          omissions: [
            ...fixture.input.omissions.filter((omission) => omission._tag !== "snapshot-warning"),
            ...warnings.map((warning) => ({ _tag: "snapshot-warning" as const, warning })),
          ],
        };
        const ids = yield* mintConversationImportIds(input);
        const command = yield* buildNativePlan({
          validated: input,
          ids,
          destination: destination(),
          importedAt: "2026-09-28T10:00:00.000Z",
        });
        // missing.pdf and gone.csv: two attachments, three warnings.
        assert.deepInclude(command.origin.omissions, { _tag: "attachments-unavailable", count: 2 });
      }),
    ),
  );

  it.effect("files a prompt whose turn has no reply under that turn, not the next one", () =>
    withImporter(
      Effect.gen(function* () {
        const fixture = importFixture({ turns: 2, workLog: true, reasoning: true });
        const { snapshot } = fixture.input;
        // Turn 1 was interrupted: its reasoning and work log remain, its reply does not.
        const messages = snapshot.messages
          .filter((message) => message.id !== "src-assistant-1")
          .map((message, index) => ({ ...message, n: index + 1 }));
        const input: typeof fixture.input = {
          ...fixture.input,
          snapshot: { ...snapshot, messages },
        };
        const ids = yield* mintConversationImportIds(input);
        const command = yield* buildNativePlan({
          validated: input,
          ids,
          destination: destination(),
          importedAt: "2026-09-28T10:00:00.000Z",
        });
        const turnOf = (externalId: string) =>
          command.messages.find((message) => message.messageId === ids.messages[externalId])
            ?.turnId;
        assert.strictEqual(turnOf("src-user-1"), ids.turns["turn:src-turn-1"]);
        assert.strictEqual(turnOf("src-reasoning-1"), ids.turns["turn:src-turn-1"]);
        assert.strictEqual(turnOf("src-user-2"), ids.turns["turn:src-turn-2"]);
        assert.strictEqual(turnOf("src-assistant-2"), ids.turns["turn:src-turn-2"]);
      }),
    ),
  );

  it.effect("gives null-turn imported reasoning a retained inherited turn", () =>
    withImporter(
      Effect.gen(function* () {
        const fixture = importFixture({ reasoning: true });
        const input: typeof fixture.input = {
          ...fixture.input,
          snapshot: {
            ...fixture.input.snapshot,
            reasoning: fixture.input.snapshot.reasoning.map((item, index) =>
              index === 0 ? { ...item, turnId: null } : item,
            ),
          },
        };
        const ids = yield* mintConversationImportIds(input);
        const command = yield* buildNativePlan({
          validated: input,
          ids,
          destination: destination(),
          importedAt: "2026-09-28T10:00:00.000Z",
        });
        const reasoning = command.messages.find((item) => item.role === "reasoning");
        assert.isNotNull(reasoning?.turnId ?? null);
        assert.include(command.inheritedTurnIds, reasoning!.turnId!);
      }),
    ),
  );

  it.effect("maps prototype-shaped external record ids as own ids", () =>
    withImporter(
      Effect.gen(function* () {
        const fixture = importFixture({ workLog: true });
        const snapshot = fixture.input.snapshot;
        const input: typeof fixture.input = {
          ...fixture.input,
          snapshot: {
            ...snapshot,
            proposedPlans: snapshot.proposedPlans.map((plan, index) =>
              index === 0 ? { ...plan, id: "__proto__" } : plan,
            ),
            workLog: snapshot.workLog.map((entry, index) =>
              index === 0 ? { ...entry, id: "constructor" } : entry,
            ),
          },
        };
        const ids = yield* mintConversationImportIds(input);
        assert.isTrue(Object.hasOwn(ids.proposedPlans, "__proto__"));
        assert.isTrue(Object.hasOwn(ids.workLog, "constructor"));
        assert.isTrue(idsCoverImport(ids, input));
        assert.isFalse(idsCoverImport({ ...ids, proposedPlans: {} }, input));
        const command = yield* buildNativePlan({
          validated: input,
          ids,
          destination: destination(),
          importedAt: "2026-09-28T10:00:00.000Z",
        });
        const projection = yield* (yield* ProjectionStoreV2).getThreadProjection(command.threadId);
        assert.strictEqual(projection.plans[0]?.id, ids.proposedPlans["__proto__"]);
        assert.isTrue(
          projection.turnItems.some(
            (item) => item.id === `${command.commandId}:item:${ids.workLog["constructor"]}`,
          ),
        );
      }),
    ),
  );

  it.effect("starts the imported thread supervised even when full access is requested", () =>
    withImporter(
      Effect.gen(function* () {
        const { lease } = yield* leaseFor(importFixture({ turns: 1 }));
        const completion = yield* importOnce(lease, importRequest({ runtimeMode: "full-access" }));
        assert.strictEqual(completion.result.destination.runtimeMode, "approval-required");
        const thread = yield* (yield* ProjectionStoreV2).getThread(completion.result.threadId);
        assert.strictEqual(thread.runtimeMode, "approval-required");
        const journal = yield* journalOf(lease.attemptDirectory);
        assert.strictEqual(journal.binding.destination.runtimeMode, "approval-required");
        // The command itself never carries another mode, whatever destination it is given.
        const command = yield* buildNativePlan({
          validated: lease.input,
          ids: journal.ids,
          destination: destination({ runtimeMode: "full-access" }),
          importedAt: journal.importedAt,
        });
        assert.strictEqual(command.runtimeMode, "approval-required");
      }),
    ),
  );

  it.effect("keeps what the sender's work log left out through import and re-export", () =>
    withImporter(
      Effect.gen(function* () {
        const fixture = importFixture({ turns: 1, workLog: true });
        const source = fixture.input.snapshot;
        const turnId = source.workLog[0]!.turnId;
        const at = (second: number) => `2026-09-27T10:00:1${second}.000Z`;
        const cut = (lines: number, chars: number) => ({
          text: `head\n[… ${lines} lines omitted …]\ntail`,
          omittedLines: lines,
          omittedChars: chars,
        });
        const workLog: typeof source.workLog = [
          {
            _tag: "tool",
            id: "src-tool-cut",
            turnId,
            createdAt: at(1),
            title: "Edit many files",
            itemType: "file_change",
            toolName: "Edit",
            status: "completed",
            command: cut(3, 30),
            detail: cut(4, 40),
            output: cut(40, 4_000),
            changedFiles: Array.from({ length: 50 }, (_, index) => `src/file-${index + 1}.ts`),
            omittedChangedFiles: 7,
          },
          {
            _tag: "task",
            id: "src-task-cut",
            turnId,
            createdAt: at(2),
            title: "Review",
            status: "completed",
            agentRole: null,
            detail: cut(5, 50),
          },
          {
            _tag: "notice",
            id: "src-notice-cut",
            turnId,
            createdAt: at(3),
            level: "warning",
            title: "Slow network",
            detail: cut(6, 60),
          },
          {
            _tag: "plan-steps",
            id: "src-plan-cut",
            turnId,
            createdAt: at(4),
            explanation: cut(8, 80),
            steps: Array.from({ length: 100 }, (_, index) => ({
              step: `Step ${index + 1}`,
              status: "pending" as const,
            })),
            omittedSteps: 12,
          },
        ];
        const input: typeof fixture.input = {
          ...fixture.input,
          snapshot: { ...source, workLog },
        };
        const { lease } = yield* leaseFor({ ...fixture, input });
        const { result } = yield* importOnce(lease);
        const snapshot = buildConversationSnapshot({
          thread: (yield* readThread(result.threadId))!,
          snapshotSequence: 1,
          threadSequence: 1,
          capturedAt: "2026-09-28T11:01:00.000Z",
          selection: { workLog: true, reasoning: false, throughMessageId: null },
          isAttachmentAvailable: () => false,
        });
        const withoutIdentity = (entries: typeof workLog) =>
          entries.map(({ id: _id, turnId: _turnId, ...entry }) => entry);
        assert.deepStrictEqual(withoutIdentity(snapshot.workLog), withoutIdentity(workLog));

        const markdown = writeConversationMarkdown({
          bundle: buildConversationDocument({
            snapshot: { ...snapshot, contentDigest: `sha256:${"a".repeat(64)}` },
            exportValue: "7f3c9a2e41b8",
            timeZone: "UTC",
            resolveAttachment: () => ({ _tag: "unavailable", reason: "missing" }),
          }).bundle,
          exportValue: "7f3c9a2e41b8",
          exported: "2026-09-28T11:01:00.000Z",
          packaging: "text",
        });
        assert.include(markdown, "and 7 more");
        assert.include(markdown, "12 more steps");
      }),
    ),
  );

  describe("file notices", () => {
    const previousImport = (notices: ReadonlyArray<string>) => ({
      _tag: "import" as const,
      source: "scic" as const,
      exportId: "previous-export",
      sourceThreadId: "previous-thread",
      packageDigest: `sha256:${"a".repeat(64)}` as const,
      sourceFormat: "scient.conversation-file",
      sourceFormatVersion: 1,
      importedAt: "2026-09-27T10:00:00.000Z",
      notices,
    });
    const warning = (
      code: "resource-unresolved" | "unsupported-construct" | "converter-reported",
      message: string,
    ) => ({ _tag: "export-warning" as const, warning: { code, message } });
    const noticesOf = (input: ReturnType<typeof importFixture>["input"]) =>
      Effect.flatMap(mintConversationImportIds(input), (ids) =>
        buildNativePlan({
          validated: input,
          ids,
          destination: destination(),
          importedAt: "2026-09-28T10:00:00.000Z",
        }),
      ).pipe(Effect.map((command) => command.origin.notices));

    it.effect("filters an earlier transfer's notices like this file's own", () =>
      withImporter(
        Effect.gen(function* () {
          const fixture = importFixture({ turns: 1 });
          const notices = yield* noticesOf({
            ...fixture.input,
            snapshot: {
              ...fixture.input.snapshot,
              provenance: previousImport([
                "Read /Users/sender/notes/secret.txt before sharing.",
                "The resource-unresolved check failed.",
                "Some diagrams were drawn as plain text.",
              ]),
            },
          });
          assert.deepStrictEqual(notices, ["Some diagrams were drawn as plain text."]);
        }),
      ),
    );

    it.effect("keeps every kind of warning, counting repeats of one kind in one line", () =>
      withImporter(
        Effect.gen(function* () {
          const fixture = importFixture({ turns: 1 });
          const notices = yield* noticesOf({
            ...fixture.input,
            warnings: [
              ...Array.from({ length: 10 }, (_, index) =>
                warning(
                  "resource-unresolved",
                  `The linked image figure-${index + 1}.png was unavailable.`,
                ),
              ),
              warning("unsupported-construct", "A table was kept as plain text."),
            ],
          });
          assert.deepStrictEqual(notices, [
            "10 linked files or images were not included.",
            "A table was kept as plain text.",
          ]);
        }),
      ),
    );

    it.effect("counts a hundred thousand warnings of one kind in one line, in linear time", () =>
      withImporter(
        Effect.gen(function* () {
          const fixture = importFixture({ turns: 1 });
          const many = (count: number) =>
            Array.from({ length: count }, (_, index) =>
              warning(
                "resource-unresolved",
                `The linked image figure-${index + 1}.png was unavailable.`,
              ),
            );
          const warnings = many(100_000);
          const startedAt = performance.now();
          const notices = yield* noticesOf({ ...fixture.input, warnings });
          const elapsedMs = performance.now() - startedAt;
          assert.deepStrictEqual(notices, ["100000 linked files or images were not included."]);
          // Copying the grouped warnings on every step took minutes here.
          assert.isBelow(elapsedMs, 1_000);
          // A kind first listed after the warnings read in full is still counted.
          const late = yield* noticesOf({
            ...fixture.input,
            warnings: [
              ...many(1_000),
              warning("unsupported-construct", "A table was kept as plain text."),
            ],
          });
          assert.deepStrictEqual(late, [
            "1000 linked files or images were not included.",
            "…and 1 more note.",
          ]);
        }),
      ),
    );

    it.effect("shares the room between earlier and new notes and counts the rest", () =>
      withImporter(
        Effect.gen(function* () {
          const fixture = importFixture({ turns: 1 });
          const earlier = Array.from({ length: 10 }, (_, index) => `Earlier note ${index + 1}.`);
          const notices = yield* noticesOf({
            ...fixture.input,
            snapshot: { ...fixture.input.snapshot, provenance: previousImport(earlier) },
            warnings: [
              warning("resource-unresolved", "The linked image chart.png was unavailable."),
              warning("unsupported-construct", "A table was kept as plain text."),
              warning("converter-reported", "A formula was kept as its source."),
            ],
          });
          assert.deepStrictEqual(notices, [
            "Earlier note 1.",
            "The linked image chart.png was unavailable.",
            "Earlier note 2.",
            "A table was kept as plain text.",
            "Earlier note 3.",
            "A formula was kept as its source.",
            "Earlier note 4.",
            "Earlier note 5.",
            "Earlier note 6.",
            "…and 4 more notes.",
          ]);
        }),
      ),
    );
  });

  it.effect("imports a package as a new independent thread with fresh ids", () =>
    withImporter(
      Effect.gen(function* () {
        const fixture = importFixture({
          turns: 3,
          reasoning: true,
          workLog: true,
          attachments: true,
        });
        const { lease, copied } = yield* leaseFor(fixture);
        const completion = yield* importOnce(lease);

        assert.strictEqual(completion.result.messageCount, 6);
        assert.strictEqual(completion.result.attachmentCount, 2);
        assert.strictEqual(completion.result.destination.projectId, PROJECT_ID);
        assert.strictEqual(completion.packageSha256, fixture.input.package.packageSha256);

        const thread = (yield* readThread(completion.result.threadId))!;
        const projection = yield* (yield* ProjectionStoreV2).getThreadProjection(
          completion.result.threadId,
        );
        assert.strictEqual(projection.thread.projectId, PROJECT_ID);
        assert.strictEqual(thread.title, "Imported design discussion");
        assert.strictEqual(thread.modelSelection.instanceId, PROVIDER_ID);
        // 3 requests, 3 answers, 3 reasoning items; no id is an external one.
        assert.strictEqual(thread.messages.length, 9);
        const sourceIds = new Set([
          ...fixture.input.snapshot.messages.map((message) => message.id),
          ...fixture.input.snapshot.reasoning.map((reasoning) => reasoning.id),
        ]);
        for (const message of thread.messages) {
          assert.isFalse(sourceIds.has(message.id));
          assert.isNotNull(message.turnId);
          assert.isFalse(message.turnId!.startsWith("src-"));
        }
        assert.notStrictEqual(thread.id, ThreadId.make("thread-on-another-machine"));

        // Each request shares a turn with the answer it started.
        const first = thread.messages.filter((message) => message.role !== "reasoning");
        assert.strictEqual(first[0]!.turnId, first[1]!.turnId);
        assert.notStrictEqual(first[1]!.turnId, first[3]!.turnId);

        // Inline references became readable text; attachments are the published copies.
        const request = first[0]!;
        assert.notInclude(request.text, "scient-ref:");
        assert.include(request.text, "figure.png");
        assert.include(request.text, "`src/app.ts`");
        assert.deepStrictEqual(
          request.attachments?.map((attachment) => [attachment.type, attachment.name]),
          [
            ["image", "figure.png"],
            ["file", "notes.txt"],
          ],
        );
        const config = yield* ServerConfig;
        for (const attachment of request.attachments ?? []) {
          assert.isTrue(attachment.id.startsWith(thread.id.toLowerCase().slice(0, 8)));
          const path = resolveAttachmentPath({
            attachmentsDir: config.attachmentsDir,
            attachment,
          })!;
          assert.isTrue(NodeFS.existsSync(path));
          assert.include(copied, path);
        }
        assert.deepStrictEqual(
          NodeFS.readFileSync(
            resolveAttachmentPath({
              attachmentsDir: config.attachmentsDir,
              attachment: request.attachments![0]!,
            })!,
            "utf8",
          ),
          "figure-bytes",
        );

        // History only: the work log and the answer, nothing pending or executable.
        assert.deepStrictEqual(thread.activities.map((activity) => activity.kind).toSorted(), [
          "tool.completed",
          "tool.completed",
          "tool.completed",
          "user-input.answer-submitted",
        ]);
        assert.strictEqual(thread.proposedPlans.length, 1);
        const shell = yield* (yield* ProjectionStoreV2).getThreadShell(thread.id);
        assert.isNotNull(shell);
        assert.isNull(shell!.pendingRuntimeRequest);
        assert.strictEqual(shell!.conversationImport?.exportId, "7f3c9a2e41b8");

        // External identity lives only in the import marker.
        assert.deepStrictEqual(thread.conversationImport, {
          source: "scic",
          exportId: "7f3c9a2e41b8",
          sourceThreadId: "thread-on-another-machine",
          packageDigest: fixture.input.package.packageSha256,
          sourceFormat: "scient.conversation-file",
          sourceFormatVersion: 1,
          importedAt: thread.conversationImport!.importedAt,
          omissions: [{ _tag: "attachments-unavailable", count: 1 }],
        });
        // Imported history cannot start a provider or restore executable requests.
        assert.deepStrictEqual(projection.runs, []);
        assert.deepStrictEqual(projection.providerSessions, []);
        assert.deepStrictEqual(projection.providerThreads, []);
        assert.deepStrictEqual(projection.runtimeRequests, []);
        assert.isTrue(projection.nodes.every((node) => !node.countsForRun && node.runId === null));
        assert.isTrue(
          projection.turnItems.every((item) => item.runId === null && item.nativeItemRef === null),
        );
        assert.deepStrictEqual(projection.thread.lineage, {
          parentThreadId: null,
          rootThreadId: thread.id,
          relationshipToParent: null,
        });
        assert.isNull(projection.thread.forkedFrom);
        assert.isNull(projection.thread.activeProviderThreadId);
        const inherited = new Set(
          projection.turnItems.flatMap((item) =>
            item.historyTurnId == null ? [] : [item.historyTurnId],
          ),
        );
        assert.deepStrictEqual(
          inherited,
          new Set(thread.messages.map((message) => message.turnId)),
        );

        // The journal names the exact paths this attempt owns.
        const journal = yield* journalOf(lease.attemptDirectory);
        assert.strictEqual(journal.ids.threadId, thread.id);
        assert.deepStrictEqual(
          journal.attachments.map((attachment) => attachment.path).toSorted(),
          [...copied].toSorted(),
        );
      }),
    ),
  );
});
