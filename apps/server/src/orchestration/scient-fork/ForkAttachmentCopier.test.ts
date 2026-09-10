// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId, type ChatAttachment } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { afterAll } from "vite-plus/test";

import { attachmentRelativePath, resolveAttachmentPathById } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  ScientForkAttachmentCopier,
  ScientForkAttachmentCopierLive,
} from "./ForkAttachmentCopier.ts";

const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scient-fork-attachments-"));
afterAll(() => NodeFS.rmSync(baseDir, { recursive: true, force: true }));

const layer = ScientForkAttachmentCopierLive.pipe(
  Layer.provideMerge(
    ServerConfig.layerTest(baseDir, { prefix: "scient-fork-attachment-copy-test-" }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

function image(id: string): ChatAttachment {
  return {
    type: "image",
    id,
    name: "evidence.png",
    mimeType: "image/png",
    sizeBytes: 8,
  };
}

it.layer(layer)("ScientForkAttachmentCopier", (it) => {
  it.effect("keeps generic fork files downloadable by their rekeyed ids", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { attachmentsDir } = yield* ServerConfig;
      const copier = yield* ScientForkAttachmentCopier;
      const source: ChatAttachment = {
        type: "file",
        id: "origin-thread-00000000-0000-4000-8000-000000000009-pdf",
        name: "report.PDF",
        mimeType: "application/pdf",
        sizeBytes: 8,
      };
      const target = { ...source, id: "fork-thread-00000000-0000-4000-8000-000000000010-pdf" };
      const sourcePath = path.join(attachmentsDir, attachmentRelativePath(source)!);
      yield* fileSystem.makeDirectory(attachmentsDir, { recursive: true });
      yield* fileSystem.writeFileString(sourcePath, "evidence");
      yield* copier.copyAll({
        threadId: ThreadId.make("fork-thread"),
        copies: [{ source, target }],
      });
      yield* fileSystem.remove(sourcePath);
      const targetPath = resolveAttachmentPathById({ attachmentsDir, attachmentId: target.id });
      assert.notStrictEqual(targetPath, null);
      assert.strictEqual(yield* fileSystem.readFileString(targetPath!), "evidence");
    }),
  );
  it.effect("copies retained images idempotently into fork-owned files", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { attachmentsDir } = yield* ServerConfig;
      const copier = yield* ScientForkAttachmentCopier;
      const threadId = ThreadId.make("fork-thread");
      const source = image("origin-thread-00000000-0000-4000-8000-000000000001");
      const target = image("fork-thread-00000000-0000-4000-8000-000000000002");
      const sourceRelativePath = attachmentRelativePath(source);
      const targetRelativePath = attachmentRelativePath(target);
      if (sourceRelativePath === null || targetRelativePath === null) {
        throw new Error("image fixtures must map to safe attachment paths");
      }
      const sourcePath = path.join(attachmentsDir, sourceRelativePath);
      const targetPath = path.join(attachmentsDir, targetRelativePath);
      yield* fileSystem.makeDirectory(attachmentsDir, { recursive: true });
      yield* fileSystem.writeFileString(sourcePath, "evidence");

      yield* copier.copyAll({ threadId, copies: [{ source, target }] });
      yield* copier.copyAll({ threadId, copies: [{ source, target }] });

      assert.strictEqual(yield* fileSystem.readFileString(targetPath), "evidence");
      yield* fileSystem.remove(sourcePath);
      yield* copier.copyAll({ threadId, copies: [{ source, target }] });
      assert.strictEqual(yield* fileSystem.readFileString(targetPath), "evidence");
    }),
  );

  it.effect("rejects a target attachment owned by another thread", () =>
    Effect.gen(function* () {
      const copier = yield* ScientForkAttachmentCopier;
      const result = yield* Effect.result(
        copier.copyAll({
          threadId: ThreadId.make("fork-thread"),
          copies: [
            {
              source: image("origin-thread-00000000-0000-4000-8000-000000000003"),
              target: image("other-thread-00000000-0000-4000-8000-000000000004"),
            },
          ],
        }),
      );
      assert.strictEqual(result._tag, "Failure");
    }),
  );
});
