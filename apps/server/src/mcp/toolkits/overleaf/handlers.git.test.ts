// @effect-diagnostics nodeBuiltinImport:off -- Real folders, Git and native publication.
/**
 * The Overleaf tools over the real step-5 service and a real local bare
 * repository standing in for Overleaf: connect, preview, sync both ways, settle
 * a conflict, list kept copies, and sync from another worktree, each saving the
 * linked folder's editors first.
 */
import * as NodePath from "node:path";

import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as AgentInvocationContext from "../../../scient/operations/AgentInvocationContext.ts";
import { OverleafEditorSave } from "../../../scient/overleaf/OverleafEditorSave.ts";
import { recordingEditorSave } from "../../../scient/overleaf/OverleafEditorSave.testkit.ts";
import { canApply } from "../../../scient/overleaf/OverleafCoordinator.testkit.ts";
import { OverleafSync } from "../../../scient/overleaf/OverleafSync.ts";
import {
  overleafSyncWorld,
  PROJECT,
  read,
  runOverleafSync,
  write,
} from "../../../scient/overleaf/OverleafSync.testkit.ts";
import {
  overleafConnectForInvocation,
  overleafKeptCopiesForInvocation,
  overleafPreviewForInvocation,
  overleafStatusForInvocation,
  overleafSyncForInvocation,
} from "./handlers.ts";

const asThread = (threadId: string) =>
  AgentInvocationContext.AgentInvocationContext.of({
    nativeSessionId: `session-${threadId}`,
    environmentId: EnvironmentId.make("environment-1"),
    threadId: ThreadId.make(threadId),
    issuedAt: 1,
    capabilities: new Set(["documents:build"]),
  });

/**
 * A thread in the main checkout and one in a worktree of the same project, the
 * tools over the real service, and the paper brought in by connect and a first sync.
 */
const connectedPaper = Effect.gen(function* () {
  const w = yield* overleafSyncWorld({ overleaf: { [PROJECT]: { "main.tex": "line\n" } } });
  w.threadRoots.set("main-thread", w.main);
  w.threadRoots.set("worktree-thread", w.worktree);
  const saver = recordingEditorSave({ _tag: "saved" });
  const as =
    (threadId: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.provideService(AgentInvocationContext.AgentInvocationContext, asThread(threadId)),
        Effect.provideService(OverleafSync, w.service),
        Effect.provideService(OverleafEditorSave, saver.service),
      );
  const folder = NodePath.join(w.main, "paper");

  const connected = yield* overleafConnectForInvocation({
    project: `https://www.overleaf.com/project/${PROJECT}`,
    mode: "new-folder",
    folder: "paper",
  }).pipe(as("main-thread"));
  if (connected.result._tag !== "done") return yield* Effect.die(connected);
  const connectionId = connected.result.connection.connectionId;
  // The result shows what the first sync will bring in, before anything changes.
  expect(connected.firstSync).toMatchObject({ _tag: "review" });
  expect(connected.lines).toContain("Would bring in 1 file: main.tex (new).");
  expect(connected.suggestNewFolder).toBe(false);
  expect(yield* read(folder, "main.tex")).toBeNull();

  const first = yield* overleafSyncForInvocation({ connectionId }).pipe(as("main-thread"));
  expect(first.result).toMatchObject({ _tag: "synced", publication: { _tag: "none" } });
  expect(first.lines[0]).toBe("1 file came in from Overleaf: main.tex (new).");
  expect(yield* read(folder, "main.tex")).toBe("line\n");

  return { w, as, saver, folder, connectionId };
});

describe.skipIf(!canApply)("Overleaf tools over real Git", () => {
  it.live("connects with a first-sync preview, then stops for a conflict and settles it", () =>
    runOverleafSync(
      Effect.gen(function* () {
        const { w, as, saver, folder, connectionId } = yield* connectedPaper;
        // Edits on both sides: the preview shows the conflict and changes nothing.
        yield* write(folder, { "main.tex": "mine\n" });
        yield* w.collaborate(PROJECT, { "main.tex": "theirs\n" });
        const preview = yield* overleafPreviewForInvocation({ connectionId }).pipe(
          as("main-thread"),
        );
        if (preview.preview._tag !== "review") return yield* Effect.die(preview);
        expect(preview.preview.review.needsDecision).toBe(true);
        const key = preview.preview.review.conflicts[0]!.key;
        expect(
          preview.lines.some((line) => line.startsWith(`- key ${key}: main.tex; allowed:`)),
        ).toBe(true);
        expect(yield* w.overleafNow(PROJECT)).toEqual({ "main.tex": "theirs\n" });

        const stopped = yield* overleafSyncForInvocation({ connectionId }).pipe(as("main-thread"));
        if (stopped.result._tag !== "needs-decision") return yield* Effect.die(stopped);
        const reviewedRemote = stopped.result.review.remoteTree;
        expect(stopped.lines[0]).toBe("Nothing was applied or sent.");
        expect(stopped.lines[1]).toContain(`reviewedRemote ${reviewedRemote}`);
        expect(yield* read(folder, "main.tex")).toBe("mine\n");

        const settled = yield* overleafSyncForInvocation({
          connectionId,
          choices: [{ key, choice: "theirs" }],
          reviewedRemote,
        }).pipe(as("main-thread"));
        expect(settled.result).toMatchObject({ _tag: "synced" });
        expect(settled.lines[0]).toBe("1 file came in from Overleaf: main.tex.");
        expect(yield* read(folder, "main.tex")).toBe("theirs\n");
        // Taking Overleaf's version kept this computer's as a copy.
        const kept = yield* overleafKeptCopiesForInvocation({ connectionId }).pipe(
          as("main-thread"),
        );
        expect(kept.copies.map((copy) => copy.relativePath)).toEqual(["main.tex"]);
        expect(kept.lines[0]).toBe("1 kept copy:");

        // Every call that may write saved the linked folder's editors first: connect's
        // first-sync preview, the first sync, the preview, and both syncs after it.
        expect(saver.calls).toEqual(
          Array.from({ length: 5 }, () => ({ checkoutRoot: w.main, folder: "paper" })),
        );
      }),
    ),
  );

  it.live("sends edits, and from another worktree syncs the linked copy and says so", () =>
    runOverleafSync(
      Effect.gen(function* () {
        const { w, as, saver, folder, connectionId } = yield* connectedPaper;
        // An edit here is sent, and the result says so.
        yield* write(folder, { "main.tex": "theirs, edited here\n" });
        const sent = yield* overleafSyncForInvocation({ connectionId }).pipe(as("main-thread"));
        expect(sent.result).toMatchObject({ _tag: "synced", publication: { _tag: "accepted" } });
        expect(sent.lines[0]).toMatch(/^Sent 1 file to Overleaf \(send #\d+\): main\.tex\.$/u);
        expect(yield* w.overleafNow(PROJECT)).toEqual({ "main.tex": "theirs, edited here\n" });

        // From another worktree the tools act on the linked copy, and say so.
        yield* write(folder, { "main.tex": "edited in main\n" });
        const fromWorktree = yield* overleafSyncForInvocation({ connectionId }).pipe(
          as("worktree-thread"),
        );
        expect(fromWorktree.link).toMatchObject({ checkoutRoot: w.main, linkedElsewhere: true });
        expect(fromWorktree.lines[0]).toBe(
          `This link belongs to the copy of the project at ${w.main}, not this worktree, so that copy was used. Your edits in this worktree are not in it until they are merged there.`,
        );
        expect(yield* w.overleafNow(PROJECT)).toEqual({ "main.tex": "edited in main\n" });
        const status = yield* overleafStatusForInvocation({}).pipe(as("worktree-thread"));
        expect(status.connections).toMatchObject([{ connectionId, linkedHere: false }]);
        expect(status.lines).toContain("No edits to send since the last sync.");

        // Every call that may write saved the linked folder's editors first, in the
        // linked copy: connect's first-sync preview and the three syncs.
        expect(saver.calls).toEqual(
          Array.from({ length: 4 }, () => ({ checkoutRoot: w.main, folder: "paper" })),
        );
      }),
    ),
  );

  it.live("keeps a new file only here, names what the rule skips, then sends it", () =>
    runOverleafSync(
      Effect.gen(function* () {
        const { w, as, folder, connectionId } = yield* connectedPaper;
        yield* write(folder, { "notes.tex": "to self\n", "main.aux": "aux\n" });
        const kept = yield* overleafSyncForInvocation({
          connectionId,
          files: { keepOnlyHere: ["notes.tex"] },
        }).pipe(as("main-thread"));
        expect(kept.result).toMatchObject({ _tag: "synced" });
        expect(kept.lines).toContain(
          "New files not sent by the rule: main.aux (build output). Send one with files.send.",
        );
        expect(yield* w.overleafNow(PROJECT)).toEqual({ "main.tex": "line\n" });

        const preview = yield* overleafPreviewForInvocation({ connectionId }).pipe(
          as("main-thread"),
        );
        expect(preview.lines).toContain(
          "Kept only on this computer: notes.tex. Send one with files.send.",
        );
        const sent = yield* overleafSyncForInvocation({
          connectionId,
          files: { send: ["notes.tex"] },
        }).pipe(as("main-thread"));
        expect(sent.result).toMatchObject({ _tag: "synced", publication: { _tag: "accepted" } });
        expect(yield* w.overleafNow(PROJECT)).toEqual({
          "main.tex": "line\n",
          "notes.tex": "to self\n",
        });
      }),
    ),
  );

  it.live("suggests a new folder when a linked folder looks like more than a paper", () =>
    runOverleafSync(
      Effect.gen(function* () {
        const w = yield* overleafSyncWorld();
        w.threadRoots.set("main-thread", w.main);
        yield* write(w.main, {
          "paper.tex": "x",
          ...Object.fromEntries(
            ["a.py", "b.py", "c.csv", "d.ipynb", "e.json"].map((name) => [`analysis/${name}`, "1"]),
          ),
        });
        const connected = yield* overleafConnectForInvocation({
          project: PROJECT,
          mode: "link-folder",
          folder: "",
        }).pipe(
          Effect.provideService(
            AgentInvocationContext.AgentInvocationContext,
            asThread("main-thread"),
          ),
          Effect.provideService(OverleafSync, w.service),
          Effect.provideService(OverleafEditorSave, recordingEditorSave({ _tag: "saved" }).service),
        );
        expect(connected.result).toMatchObject({ _tag: "done" });
        expect(connected.suggestNewFolder).toBe(true);
        expect(
          connected.lines.some((line) =>
            line.startsWith("This folder looks like more than a paper"),
          ),
        ).toBe(true);
        // Information only: the link is made and nothing was sent.
        expect(yield* w.overleafNow(PROJECT)).toEqual({ "main.tex": "from Overleaf" });
      }),
    ),
  );
});
