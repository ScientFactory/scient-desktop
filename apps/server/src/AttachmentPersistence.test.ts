import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { MessageId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { persistChatAttachments } from "./AttachmentPersistence.ts";
import { attachmentRelativePath } from "./attachmentStore.ts";
import * as ServerConfig from "./config.ts";

it.effect("an interrupted upload cannot publish partial bytes or block equal retries", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const input = {
      threadId: ThreadId.make("atomic-upload-thread"),
      messageId: MessageId.make("atomic-upload-message"),
      attachments: [
        {
          type: "image" as const,
          name: "image.png",
          mimeType: "image/png",
          sizeBytes: 4,
          dataUrl: "data:image/png;base64,AAECAw==",
        },
      ],
    };
    const interruptedFs = FileSystem.FileSystem.of({
      ...fs,
      writeFile: (filename, bytes, options) =>
        filename.includes(".attachment-upload-")
          ? fs
              .writeFile(filename, bytes.subarray(0, 1), options)
              .pipe(Effect.andThen(Effect.die("simulated interruption before publication")))
          : fs.writeFile(filename, bytes, options),
    });
    const interrupted = yield* persistChatAttachments(input).pipe(
      Effect.provideService(FileSystem.FileSystem, interruptedFs),
      Effect.exit,
    );
    assert.equal(interrupted._tag, "Failure");
    assert.deepEqual(yield* fs.readDirectory(config.attachmentsDir), []);
    const [first, repeated] = yield* Effect.all(
      [persistChatAttachments(input), persistChatAttachments(input)],
      { concurrency: 2 },
    );
    assert.deepEqual(first, repeated);
    const destination = path.join(config.attachmentsDir, attachmentRelativePath(first[0]!)!);
    assert.deepEqual(Array.from(yield* fs.readFile(destination)), [0, 1, 2, 3]);
    const conflict = yield* persistChatAttachments({
      ...input,
      attachments: [{ ...input.attachments[0]!, dataUrl: "data:image/png;base64,BAUGBw==" }],
    }).pipe(Effect.exit);
    assert.equal(conflict._tag, "Failure");
    assert.deepEqual(Array.from(yield* fs.readFile(destination)), [0, 1, 2, 3]);
  }).pipe(
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "atomic-attachment-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
);
