import { describe, expect, it } from "@effect/vitest";
import { CloudConversation, type SnapshotSidecar } from "@scientfactory/scient-cloud/api";
import { type ConversationSnapshotV1, MessageId, ThreadId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import { AccountsService } from "../accounts/AccountsService.ts";
import { ConversationSnapshotService } from "../conversationExport/ConversationSnapshotService.ts";
import { attachment, capturedSnapshot } from "../conversationFile/scic.test-fixtures.ts";
import { ConversationExtras } from "./ConversationExtras.ts";
import { ShareBuilder, layer } from "./ShareBuilder.ts";

const SAVED = "lab-db-password-42";
const decodeDocument = Schema.decodeUnknownSync(Schema.fromJsonString(CloudConversation));

const builderFor = Effect.fn("ShareBuilderTest.builderFor")(function* (
  snapshot: ConversationSnapshotV1,
  files: Record<string, string | Uint8Array>,
  sidecar: SnapshotSidecar = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "scient-share-build-" });
  const attachmentFiles = new Map<string, string>();
  for (const [localId, content] of Object.entries(files)) {
    const file = path.join(dir, localId);
    yield* typeof content === "string"
      ? fs.writeFileString(file, content)
      : fs.writeFile(file, content);
    attachmentFiles.set(localId, file);
  }
  const snapshots = ConversationSnapshotService.of({
    capture: () => Effect.succeed({ snapshot, attachmentFiles }),
  });
  const accounts = {
    redactionValues: Effect.succeed([Redacted.make(SAVED)]),
  } as unknown as AccountsService["Service"];
  const extras = ConversationExtras.of({ read: () => Effect.succeed({ sidecar }) });
  const builder = yield* ShareBuilder.pipe(
    Effect.provide(layer),
    Effect.provideService(ConversationSnapshotService, snapshots),
    Effect.provideService(AccountsService, accounts),
    Effect.provideService(ConversationExtras, extras),
  );
  return (keep: ReadonlyArray<string> = []) =>
    builder.build({
      threadId: ThreadId.make("thread-1"),
      reasoning: false,
      workLog: true,
      excludeMessageIds: [MessageId.make("message-2")],
      keep,
    });
});

const makeBuilder = Effect.gen(function* () {
  const snapshot = {
    ...capturedSnapshot,
    messages: [
      {
        ...capturedSnapshot.messages[0]!,
        text: `Use ${SAVED} and mail ada@lab.example.org`,
        attachments: [
          attachment("a-notes", "file", "notes.txt", "text/plain", 30),
          attachment("a-figure", "image", "figure.png", "image/png", 4),
        ],
        references: [],
      },
      capturedSnapshot.messages[1]!,
      { ...capturedSnapshot.messages[1]!, n: 3, id: MessageId.make("message-3"), text: "Final" },
    ],
    warnings: [],
  };
  return yield* builderFor(snapshot, {
    "a-notes": `connect with ${SAVED}`,
    "a-figure": new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
  });
});

const EMAIL = "ada@lab.example.org";
const HOME = "/Users/ada";
const TOKEN = `ghp_${"Z".repeat(36)}`;
const PLANTED = [SAVED, EMAIL, HOME, TOKEN];

describe("ShareBuilder", () => {
  it.effect("publishes a redacted, renumbered document and reports without values", () =>
    Effect.gen(function* () {
      const build = yield* makeBuilder;
      const built = yield* build();
      expect(built.documentJson).not.toContain(SAVED);
      expect(built.documentJson).not.toContain("ada@lab.example.org");
      const { snapshot, sidecar } = decodeDocument(built.documentJson);
      expect(snapshot.messages.map((m) => [m.n, m.id])).toEqual([
        [1, "message-1"],
        [2, "message-3"],
      ]);
      expect(snapshot.messages[0]!.text).toBe("Use [redacted] and mail [email]");
      expect(snapshot.contentDigest).toBe(built.contentDigest);
      expect(snapshot.contentDigest).not.toBe(capturedSnapshot.contentDigest);
      // The notes file holds the saved value, so only the figure travels.
      expect(built.blobs.map((blob) => blob.localId)).toEqual(["a-figure"]);
      expect(sidecar?.attachments?.map((entry) => entry.localId)).toEqual(["a-figure"]);
      expect(
        snapshot.messages[0]!.attachments.find((a) => a.localId === "a-notes")?.available,
      ).toBe(false);
      expect(built.redactions.map((entry) => entry.kind).toSorted()).toEqual([
        "attachment",
        "email",
        "saved-secret",
      ]);
      expect(JSON.stringify(built.redactions)).not.toContain(SAVED);
      expect(built.coverage.binaryAttachmentsNotSearched).toBe(1);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("keeps an attachment the person chose to keep", () =>
    Effect.gen(function* () {
      const build = yield* makeBuilder;
      const first = yield* build();
      const attachmentId = first.redactions.find((entry) => entry.kind === "attachment")!.id;
      const second = yield* build([attachmentId]);
      expect(second.blobs.map((blob) => blob.localId).toSorted()).toEqual(["a-figure", "a-notes"]);
      expect(second.kept.map((entry) => entry.id)).toEqual([attachmentId]);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
  it.effect("never lets a planted value reach the document, the report or a blob name", () =>
    Effect.gen(function* () {
      const message = capturedSnapshot.messages[0]!;
      const build = yield* builderFor(
        {
          ...capturedSnapshot,
          provenance: {
            _tag: "import",
            source: "scic",
            exportId: "export-1",
            sourceThreadId: null,
            packageDigest: `sha256:${"a".repeat(64)}`,
            sourceFormat: "scient.conversation",
            sourceFormatVersion: 1,
            importedAt: "2026-09-27T13:00:00.000Z",
            notices: [`Exported by ${EMAIL} from ${HOME}/lab with ${TOKEN}`],
          },
          messages: [
            {
              ...message,
              text: `Run with ${SAVED} as ${EMAIL} in ${HOME}/lab, token ${TOKEN}`,
              references: [],
              attachments: [
                attachment("a-contacts", "file", "contacts.csv", `text/csv; owner=${EMAIL}`, 40),
                attachment("a-keys", "file", `keys-${EMAIL}.txt`, "text/plain", 40),
                attachment("a-plot", "image", `plot-${SAVED}.png`, "image/png", 4),
              ],
            },
          ],
          warnings: [
            { _tag: "attachment-unavailable", name: `${HOME}/missing-${SAVED}.csv`, messageN: 1 },
          ],
        },
        {
          "a-contacts": `name,email\nAda,${EMAIL}\n`,
          "a-keys": `token=${TOKEN}`,
          "a-plot": new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
        },
        { repository: { webUrl: `https://ada:${SAVED}@github.com/acme/lab`, commit: "abc123" } },
      );
      const built = yield* build();
      const { snapshot } = decodeDocument(built.documentJson);
      // Only the binary plot travels; both text files hold private text.
      expect(built.blobs.map((blob) => [blob.localId, blob.name])).toEqual([
        ["a-plot", "plot-[redacted].png"],
      ]);
      expect(
        Object.fromEntries(snapshot.messages[0]!.attachments.map((a) => [a.localId, a.available])),
      ).toEqual({ "a-contacts": false, "a-keys": false, "a-plot": true });
      const served = JSON.stringify({
        ...built,
        blobs: built.blobs.map(({ path: _local, ...blob }) => blob),
      });
      for (const value of PLANTED) expect(served).not.toContain(value);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
