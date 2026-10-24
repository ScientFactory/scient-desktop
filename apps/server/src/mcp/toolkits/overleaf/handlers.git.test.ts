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
 * tools over the real service, and the paper linked and brought in through the
 * service itself (the connect tool has its own test), so each test spends its
 * real Git round trips on what it checks.
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
  const connected = yield* w.service.connect({
    caller: w.at(w.main),
    folder: "paper",
    create: true,
    project: PROJECT,
    requestId: "c1",
  });
  if (connected._tag !== "connected") return yield* Effect.die(connected);
  const connectionId = connected.connection.connectionId;
  yield* w.service.sync({ caller: w.at(w.main), connectionId, requestId: "s1" });
  expect(yield* read(folder, "main.tex")).toBe("line\n");
  return { w, as, saver, folder, connectionId };
});

describe.skipIf(!canApply)("Overleaf tools over real Git", () => {
  it.live("stops for a conflict, then settles it with the reviewed choice", () =>
    runOverleafSync(
      Effect.gen(function* () {
        const { w, as, saver, folder, connectionId } = yield* connectedPaper;
        // Edits on both sides: the sync stops on the conflict and changes nothing.
        yield* write(folder, { "main.tex": "mine\n" });
        yield* w.collaborate(PROJECT, { "main.tex": "theirs\n" });
        const stopped = yield* overleafSyncForInvocation({ connectionId }).pipe(as("main-thread"));
        if (stopped.result._tag !== "needs-decision") return yield* Effect.die(stopped);
        const reviewedRemote = stopped.result.review.remoteTree;
        const key = stopped.result.review.conflicts[0]!.key;
        expect(stopped.lines[0]).toBe(
          "Stopped at a conflict before applying this review: none of its changes were applied or sent.",
        );
        expect(stopped.lines[1]).toContain(`reviewedRemote ${reviewedRemote}`);
        expect(
          stopped.lines.some((line) => line.startsWith(`- key ${key}: main.tex; allowed:`)),
        ).toBe(true);
        expect(yield* read(folder, "main.tex")).toBe("mine\n");
        expect(yield* w.overleafNow(PROJECT)).toEqual({ "main.tex": "theirs\n" });

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

        // Both syncs saved the linked folder's editors first.
        expect(saver.calls).toEqual(
          Array.from({ length: 2 }, () => ({ checkoutRoot: w.main, folder: "paper" })),
        );
      }),
    ),
  );

  it.live("from another worktree syncs and sends from the linked copy, and says so", () =>
    runOverleafSync(
      Effect.gen(function* () {
        const { w, as, saver, folder, connectionId } = yield* connectedPaper;
        // From another worktree the tools act on the linked copy, send its edit, and say so.
        yield* write(folder, { "main.tex": "edited in main\n" });
        const fromWorktree = yield* overleafSyncForInvocation({ connectionId }).pipe(
          as("worktree-thread"),
        );
        expect(fromWorktree.result).toMatchObject({
          _tag: "synced",
          publication: { _tag: "accepted" },
        });
        expect(fromWorktree.lines[1]).toMatch(
          /^Sent 1 file to Overleaf \(send #\d+\): main\.tex\.$/u,
        );
        expect(fromWorktree.link).toMatchObject({ checkoutRoot: w.main, linkedElsewhere: true });
        expect(fromWorktree.lines[0]).toBe(
          `This link belongs to the copy of the project at ${w.main}, not this worktree, so that copy was used. Your edits in this worktree are not in it until they are merged there.`,
        );
        expect(yield* w.overleafNow(PROJECT)).toEqual({ "main.tex": "edited in main\n" });
        const status = yield* overleafStatusForInvocation({}).pipe(as("worktree-thread"));
        expect(status.connections).toMatchObject([{ connectionId, linkedHere: false }]);
        expect(status.lines).toContain("No edits to send since the last sync.");

        // The sync saved the linked folder's editors first, in the linked copy.
        expect(saver.calls).toEqual(
          Array.from({ length: 1 }, () => ({ checkoutRoot: w.main, folder: "paper" })),
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

  it.live(
    "connects with a first-sync preview, and suggests a new folder for more than a paper",
    () =>
      runOverleafSync(
        Effect.gen(function* () {
          const w = yield* overleafSyncWorld();
          w.threadRoots.set("main-thread", w.main);
          w.threadRoots.set("worktree-thread", w.worktree);
          const saver = recordingEditorSave({ _tag: "saved" });
          const as =
            (threadId: string) =>
            <A, E, R>(effect: Effect.Effect<A, E, R>) =>
              effect.pipe(
                Effect.provideService(
                  AgentInvocationContext.AgentInvocationContext,
                  asThread(threadId),
                ),
                Effect.provideService(OverleafSync, w.service),
                Effect.provideService(OverleafEditorSave, saver.service),
              );
          // A new folder: the result shows what the first sync will bring in, changing nothing.
          const fresh = yield* overleafConnectForInvocation({
            project: `https://www.overleaf.com/project/${PROJECT}`,
            mode: "new-folder",
            folder: "paper",
          }).pipe(as("worktree-thread"));
          expect(fresh.result).toMatchObject({ _tag: "done" });
          expect(fresh.firstSync).toMatchObject({ _tag: "review" });
          expect(fresh.lines).toContain("Would bring in 1 file: main.tex (new).");
          expect(fresh.suggestNewFolder).toBe(false);
          expect(yield* read(NodePath.join(w.worktree, "paper"), "main.tex")).toBeNull();
          // The preview saved the new folder's editors first.
          expect(saver.calls).toEqual([{ checkoutRoot: w.worktree, folder: "paper" }]);

          // Another copy linking its top folder, which holds analysis too.
          yield* write(w.main, {
            "paper.tex": "x",
            ...Object.fromEntries(
              ["a.py", "b.py", "c.csv", "d.ipynb", "e.json"].map((name) => [
                `analysis/${name}`,
                "1",
              ]),
            ),
          });
          const connected = yield* overleafConnectForInvocation({
            project: PROJECT,
            mode: "link-folder",
            folder: "",
          }).pipe(as("main-thread"));
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
