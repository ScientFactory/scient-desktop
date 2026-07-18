// FILE: promptAttachments.test.ts
// Purpose: Locks provider prompt attachment filtering so UI-only context chips do not reach native providers.
// Layer: Provider adapter utility tests
// Depends on: promptAttachments helper and shared chat attachment contracts.

import * as NodeServices from "@effect/platform-node/NodeServices";
import { MessageId, type ChatAttachment } from "@synara/contracts";
import { Effect, FileSystem } from "effect";
import { describe, expect, it } from "vitest";

import {
  filterProviderPromptImageAttachments,
  readProviderPromptImage,
} from "./promptAttachments.ts";

describe("filterProviderPromptImageAttachments", () => {
  it("keeps images while dropping assistant selections from provider-native prompts", () => {
    const imageAttachment = {
      type: "image",
      id: "thread-1-image-1",
      name: "screen.png",
      mimeType: "image/png",
      sizeBytes: 128,
    } satisfies ChatAttachment;
    const selectionAttachment = {
      type: "assistant-selection",
      id: "thread-1-selection-1",
      assistantMessageId: MessageId.makeUnsafe("assistant-message-1"),
      text: "Selected assistant text is already serialized into the prompt body.",
    } satisfies ChatAttachment;

    expect(filterProviderPromptImageAttachments([selectionAttachment, imageAttachment])).toEqual([
      imageAttachment,
    ]);
  });
});

describe("readProviderPromptImage", () => {
  it("reads exactly the persisted size", async () => {
    const bytes = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const directory = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "scient-provider-image-",
          });
          const path = `${directory}/image.png`;
          yield* fileSystem.writeFile(path, Uint8Array.from([1, 2, 3, 4]));

          return yield* readProviderPromptImage({
            fileSystem,
            path,
            expectedBytes: 4,
          });
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );

    expect([...bytes]).toEqual([1, 2, 3, 4]);
  });

  it("rejects a file that no longer matches its attachment metadata", async () => {
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const directory = yield* fileSystem.makeTempDirectoryScoped({
            prefix: "scient-provider-image-",
          });
          const path = `${directory}/image.png`;
          yield* fileSystem.writeFile(path, Uint8Array.from([1, 2, 3, 4, 5]));

          return yield* readProviderPromptImage({
            fileSystem,
            path,
            expectedBytes: 4,
          });
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
    );

    expect(exit._tag).toBe("Failure");
    if (exit._tag === "Failure") {
      expect(String(exit.cause)).toContain("does not match its metadata");
    }
  });
});
