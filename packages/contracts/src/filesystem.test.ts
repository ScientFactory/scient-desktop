import { assert, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { FilesystemBrowseInput, FilesystemBrowseResult } from "./filesystem";

it.effect("preserves exact whitespace in filesystem browse paths and entries", () =>
  Effect.gen(function* () {
    const input = yield* Schema.decodeUnknownEffect(FilesystemBrowseInput)({
      partialPath: "/Users/tester/Research ",
      cwd: " /mounted workspace",
    });
    const result = yield* Schema.decodeUnknownEffect(FilesystemBrowseResult)({
      parentPath: "/Users/tester/Research ",
      entries: [
        {
          name: " notes ",
          fullPath: "/Users/tester/Research / notes ",
        },
      ],
    });

    assert.strictEqual(input.partialPath, "/Users/tester/Research ");
    assert.strictEqual(input.cwd, " /mounted workspace");
    assert.strictEqual(result.parentPath, "/Users/tester/Research ");
    assert.strictEqual(result.entries[0]?.name, " notes ");
    assert.strictEqual(result.entries[0]?.fullPath, "/Users/tester/Research / notes ");
  }),
);
