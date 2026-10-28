// @effect-diagnostics nodeBuiltinImport:off -- Real folders and native publication.
/**
 * A confirm whose review stands unchanged reads the folder again; a credential
 * renewed while it reads makes the review stale, as building it again would.
 * The hook is the folder read itself: opening the manuscript file.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { vi } from "vite-plus/test";

import { CONNECTION, canApply, read, run, world } from "./OverleafCoordinator.testkit.ts";

describe.skipIf(!canApply)("OverleafCoordinator, confirm epochs", () => {
  it.live("a credential renewed while confirm reads the folder makes the review stale", () =>
    run(
      Effect.gen(function* () {
        let epoch = 0;
        const w = yield* world({
          synced: { "main.tex": "A" },
          remote: { "main.tex": "B" },
          credentialEpoch: () => epoch,
        });
        const prepared = yield* w.coordinator.prepare({ connectionId: CONNECTION });
        if (prepared._tag !== "review") return yield* Effect.die(prepared);
        const manuscript = NodePath.join(w.folder, "main.tex");
        const open = NodeFS.promises.open;
        using _opened = vi.spyOn(NodeFS.promises, "open").mockImplementation(async (...args) => {
          const handle = await open(...args);
          if (args[0] === manuscript && epoch === 0) epoch += 1;
          return handle;
        });
        const confirmed = yield* w.coordinator.confirm({
          connectionId: CONNECTION,
          requestId: "renewed",
          reviewId: prepared.review.id,
          digest: prepared.review.digest,
          acknowledgements: prepared.review.binding.acknowledgements,
        });
        expect(epoch).toBe(1);
        expect(confirmed).toMatchObject({ _tag: "stale", reason: "credential-epoch" });
        expect(yield* read(w.folder, "main.tex")).toBe("A");
      }),
    ),
  );
});
