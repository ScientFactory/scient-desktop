// @effect-diagnostics nodeBuiltinImport:off -- Real local Git repositories and manuscript folders.
import * as NodePath from "node:path";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { canApply } from "./OverleafCoordinator.testkit.ts";
import { OVERLEAF_LIMITS } from "./OverleafInventory.ts";
import {
  overleafSyncWorld as world,
  PROJECT,
  read,
  runOverleafSync as run,
  write,
} from "./OverleafSync.testkit.ts";

it.live.skipIf(!canApply)(
  "reads both review trees without syncing and refuses a replaced or consumed review",
  () =>
    run(
      Effect.gen(function* () {
        const initial = {
          "remote.tex": "remote before\n",
          "local.tex": "local before\n",
          "removed.tex": "remove me\n",
          "conflict.tex": "base\n",
        };
        const w = yield* world({ overleaf: { [PROJECT]: initial } });
        const caller = w.at(w.main);
        const connected = yield* w.service.connect({
          caller,
          folder: "paper",
          create: true,
          project: PROJECT,
          requestId: "connect",
        });
        if (connected._tag !== "connected") return yield* Effect.die(connected);
        const connectionId = connected.connection.connectionId;
        yield* w.service.sync({ caller, connectionId, requestId: "initial" });
        const folder = NodePath.join(w.main, "paper");
        yield* write(folder, {
          "local.tex": "local after\n",
          "empty.tex": "",
          "conflict.tex": "mine\n",
        });
        const remote = {
          "local.tex": initial["local.tex"],
          "remote.tex": "remote after\n",
          "conflict.tex": "theirs\n",
          "binary.pdf": "a\0b",
          "large.tex": "x".repeat(OVERLEAF_LIMITS.previewBytes + 1),
          ...Object.fromEntries(
            Array.from({ length: 8 }, (_, i) => [
              `z-budget-${i}.tex`,
              "z".repeat(OVERLEAF_LIMITS.previewBytes),
            ]),
          ),
        };
        yield* w.collaborate(PROJECT, remote);
        const first = yield* w.service.preview({ caller, connectionId });
        if (first._tag !== "review") return yield* Effect.die(first);
        const preview = yield* w.service.preview({
          caller,
          connectionId,
          choices: new Map([[first.review.conflicts[0]!.key, "markers"]]),
        });
        if (preview._tag !== "review") return yield* Effect.die(preview);
        const recordBefore = yield* w.store.readConnection(connectionId);
        const savedEditors = w.editorSaves.length;
        const remoteHead = yield* read(w.overleafFor(PROJECT), "refs/heads/master");
        const result = yield* w.service.diff({
          caller,
          connectionId,
          reviewId: preview.review.reviewId,
        });
        if (result._tag !== "diff") return yield* Effect.die(result);
        expect(result.incoming).toContainEqual({
          _tag: "text",
          path: "remote.tex",
          before: "remote before\n",
          after: "remote after\n",
        });
        expect(result.incoming.some((file) => file.path === "local.tex")).toBe(false);
        expect(result.outgoing).toContainEqual({
          _tag: "text",
          path: "local.tex",
          before: "local before\n",
          after: "local after\n",
        });
        expect(result.outgoing).toContainEqual({
          _tag: "text",
          path: "empty.tex",
          before: null,
          after: "",
        });
        // The publication holds back conflict marks, even though the candidate contains them.
        expect(result.outgoing).toContainEqual({
          _tag: "text",
          path: "conflict.tex",
          before: "base\n",
          after: "theirs\n",
        });
        expect(result.incoming).toContainEqual({
          _tag: "not-shown",
          path: "binary.pdf",
          reason: "binary",
        });
        expect(result.incoming).toContainEqual({
          _tag: "not-shown",
          path: "large.tex",
          reason: "file-too-large",
        });
        expect(result.incoming).toContainEqual({
          _tag: "text",
          path: "removed.tex",
          before: "remove me\n",
          after: null,
        });
        expect(
          [...result.incoming, ...result.outgoing].some(
            (file) => file._tag === "not-shown" && file.reason === "total-limit",
          ),
        ).toBe(true);
        const shownBytes = [...result.incoming, ...result.outgoing].reduce(
          (total, file) =>
            file._tag === "text"
              ? total +
                new TextEncoder().encode(file.before ?? "").length +
                new TextEncoder().encode(file.after ?? "").length
              : total,
          0,
        );
        expect(shownBytes).toBeLessThanOrEqual(OVERLEAF_LIMITS.editableTotalBytes);
        expect(yield* read(folder, "remote.tex")).toBe("remote before\n");
        expect(yield* read(w.overleafFor(PROJECT), "refs/heads/master")).toBe(remoteHead);
        expect(yield* w.store.readConnection(connectionId)).toEqual(recordBefore);
        expect(w.editorSaves).toHaveLength(savedEditors);
        // Reading does not consume the review.
        expect(
          yield* w.service.diff({ caller, connectionId, reviewId: preview.review.reviewId }),
        ).toEqual(result);
        expect(
          yield* w.service.diff({ caller, connectionId, reviewId: first.review.reviewId }),
        ).toEqual({ _tag: "stale", reason: "check-again" });
        const synced = yield* w.service.sync({
          caller,
          connectionId,
          requestId: "consume",
          choices: new Map([[first.review.conflicts[0]!.key, "theirs"]]),
        });
        if (synced._tag !== "synced") return yield* Effect.die(synced);
        expect(
          yield* w.service.diff({ caller, connectionId, reviewId: synced.review.reviewId }),
        ).toEqual({ _tag: "stale", reason: "check-again" });
      }),
    ),
);
