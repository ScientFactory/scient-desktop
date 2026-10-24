// @effect-diagnostics nodeBuiltinImport:off -- Real folders and native publication.
/**
 * A confirm whose review stands unchanged reads the folder again; a credential
 * renewed while it reads makes the review stale, as building it again would.
 * The hook is the folder read itself: opening the manuscript file.
 */
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { vi } from "vite-plus/test";

import { CONNECTION, canApply, read, run, world } from "./OverleafCoordinator.testkit.ts";

const hook = vi.hoisted(() => ({ opened: undefined as ((path: unknown) => void) | undefined }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      hook.opened?.(args[0]);
      return handle;
    },
  };
});

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
        hook.opened = (path) => {
          if (path !== manuscript) return;
          epoch += 1;
          hook.opened = undefined;
        };
        const confirmed = yield* w.coordinator
          .confirm({
            connectionId: CONNECTION,
            requestId: "renewed",
            reviewId: prepared.review.id,
            digest: prepared.review.digest,
            acknowledgements: prepared.review.binding.acknowledgements,
          })
          .pipe(Effect.ensuring(Effect.sync(() => (hook.opened = undefined))));
        expect(epoch).toBe(1);
        expect(confirmed).toMatchObject({ _tag: "stale", reason: "credential-epoch" });
        expect(yield* read(w.folder, "main.tex")).toBe("A");
      }),
    ),
  );
});
