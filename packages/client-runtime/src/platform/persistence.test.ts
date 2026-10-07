import {
  OrchestrationProjectShell,
  OrchestrationV2ShellSnapshot,
  OrchestrationV2ShellSnapshotJson,
  OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Arbitrary from "effect/unstable/arbitrary/Arbitrary";

import { encodeShellSnapshotForCache } from "./persistence.ts";

// Generated values can hold untrimmed strings, which a decoded value never
// has. One encode and decode gives a value a client can hold; values that
// fail are dropped. Size 30 makes the generator fill optional fields, while
// a few hundred samples keep the property test reliable under CI contention.
const sampleDecoded = <S extends Schema.Constraint>(schema: S) =>
  Effect.gen(function* () {
    const encode = Schema.encodeEffect(schema);
    const decode = Schema.decodeEffect(schema);
    const generated = yield* Arbitrary.sampleEffect(Arbitrary.schema(schema), {
      count: 256,
      size: 30,
    });
    const decoded = yield* Effect.forEach(generated, (value) =>
      encode(value).pipe(Effect.flatMap(decode), Effect.option),
    );
    return Arr.getSomes(decoded);
  });

// The cache persists the Json variant, so this is what actually reads the payload back.
const decodeCacheSnapshot = Schema.decodeEffect(OrchestrationV2ShellSnapshotJson);

describe("encodeShellSnapshotForCache", () => {
  it.effect("round-trips a generated snapshot through the cache encoding", () =>
    Effect.gen(function* () {
      const threads = yield* sampleDecoded(OrchestrationV2ThreadShell);
      const projects = yield* sampleDecoded(OrchestrationProjectShell);
      const snapshot: OrchestrationV2ShellSnapshot = {
        schemaVersion: 3,
        snapshotSequence: 1,
        // The generator rarely makes monogram icons, and they are the one
        // project field whose encoding differs from the decoded value.
        projects: projects.map((project, index) =>
          index % 2 === 0
            ? { ...project, projectIcon: { kind: "monogram", text: "T3", color: "blue" } }
            : project,
        ),
        threads,
        archivedThreads: [],
      };

      expect(threads.length).toBeGreaterThan(0);
      expect(projects.length).toBeGreaterThan(0);
      expect(yield* decodeCacheSnapshot(yield* encodeShellSnapshotForCache(snapshot))).toEqual(
        snapshot,
      );
    }),
  );
});
