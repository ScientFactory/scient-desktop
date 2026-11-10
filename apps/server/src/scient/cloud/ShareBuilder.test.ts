import { describe, expect, it } from "@effect/vitest";
import { CloudConversation } from "@scientfactory/scient-cloud/api";
import { MessageId, ThreadId } from "@t3tools/contracts";
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

const makeBuilder = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "scient-share-build-" });
  const notes = path.join(dir, "notes.txt");
  const figure = path.join(dir, "figure.png");
  yield* fs.writeFileString(notes, `connect with ${SAVED}`);
  yield* fs.writeFile(figure, new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
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
  const snapshots = ConversationSnapshotService.of({
    capture: () =>
      Effect.succeed({
        snapshot,
        attachmentFiles: new Map([
          ["a-notes", notes],
          ["a-figure", figure],
        ]),
      }),
  });
  const accounts = {
    redactionValues: Effect.succeed([Redacted.make(SAVED)]),
  } as unknown as AccountsService["Service"];
  const extras = ConversationExtras.of({ read: () => Effect.succeed({ sidecar: {} }) });
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
});
