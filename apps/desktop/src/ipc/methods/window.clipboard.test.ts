import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as ElectronShell from "../../electron/ElectronShell.ts";
import * as IpcChannels from "../channels.ts";
import { copyPngToClipboard } from "./window.ts";

function runCopyHandler(raw: unknown, copyPng: ElectronShell.ElectronShell["Service"]["copyPng"]) {
  return copyPngToClipboard.handler(raw).pipe(
    Effect.provideService(ElectronShell.ElectronShell, {
      copyPng,
      copyText: () => Effect.void,
      openExternal: () => Effect.succeed(false),
      openSystemSettings: () => Effect.succeed(false),
    }),
  );
}

describe("desktop PNG clipboard IPC", () => {
  it("uses the dedicated channel and forwards validated bytes", () => {
    assert.strictEqual(copyPngToClipboard.channel, IpcChannels.COPY_PNG_TO_CLIPBOARD_CHANNEL);
  });

  it.effect("forwards PNG bytes to the native clipboard service", () =>
    Effect.gen(function* () {
      const calls: Uint8Array[] = [];
      const png = new Uint8Array([137, 80, 78, 71]);

      yield* runCopyHandler(png, (input) =>
        Effect.sync(() => {
          calls.push(input);
          return true;
        }),
      );

      assert.deepEqual(
        calls.map((input) => [...input]),
        [[...png]],
      );
    }),
  );

  it.effect("rejects empty and undecodable image payloads", () =>
    Effect.gen(function* () {
      const emptyResult = yield* Effect.result(
        runCopyHandler(new Uint8Array(), () => Effect.succeed(true)),
      );
      assert.equal(emptyResult._tag, "Failure");
      if (emptyResult._tag === "Failure") {
        assert.instanceOf(emptyResult.failure, Error);
        assert.include(emptyResult.failure.message, "empty");
      }

      const decodeResult = yield* Effect.result(
        runCopyHandler(new Uint8Array([1, 2, 3]), () => Effect.succeed(false)),
      );
      assert.equal(decodeResult._tag, "Failure");
      if (decodeResult._tag === "Failure") {
        assert.instanceOf(decodeResult.failure, Error);
        assert.include(decodeResult.failure.message, "could not decode");
      }
    }),
  );
});
