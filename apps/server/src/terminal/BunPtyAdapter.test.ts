import { describe } from "vite-plus/test";
import { assert, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as BunPtyAdapter from "./BunPtyAdapter.ts";

describe("Restored BunPtyAdapter.test.ts", () => {
  // regression: 13a4789a5d [codex] Structure terminal adapter startup defects (#3425)

  it.effect("reports unsupported platforms with a structured startup defect", () =>
    Effect.gen(function* () {
      const exit = yield* BunPtyAdapter.make().pipe(
        Effect.provideService(HostProcess.Platform, "win32"),
        Effect.exit,
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.hasDies(exit.cause)).toBe(true);
        const error = Cause.squash(exit.cause);
        assert.instanceOf(error, BunPtyAdapter.BunPtyUnsupportedPlatformError);
        expect(error).toMatchObject({
          _tag: "BunPtyUnsupportedPlatformError",
          platform: "win32",
        });
        expect(error.message).toBe(
          "Bun PTY terminal support is unavailable on win32. Run the Scient server with Node.js instead.",
        );
      }
    }),
  );
});
