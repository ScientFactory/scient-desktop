/**
 * The Overleaf tools against a fake service, where real Git is not the point:
 * what an editor that could not save says, errors as fixed categories, and the token
 * flow through a secretRef. The real service runs in handlers.git.test.ts.
 */
import { EnvironmentId, SecretRef, SecretRequestError, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as AgentInvocationContext from "../../../scient/operations/AgentInvocationContext.ts";
import {
  OverleafConnectionNotReadyError,
  OverleafOperationActiveError,
} from "../../../scient/overleaf/OverleafCoordinator.ts";
import { OverleafGitError } from "../../../scient/overleaf/OverleafGitExecutor.ts";
import { OverleafRepositoryError } from "../../../scient/overleaf/OverleafRepository.ts";
import {
  OverleafEditorUnsavedError,
  OverleafSync,
  OverleafSyncRefusedError,
  type OverleafSyncShape,
} from "../../../scient/overleaf/OverleafSync.ts";
import { WorkspaceBindingResolver } from "../../../scient/projectScope/WorkspaceBindingResolver.ts";
import { workspaceResolverForTest } from "../../../scient/projectScope/WorkspaceBindingTestUtils.ts";
import { SecretRequests } from "../../../secrets/SecretRequests.ts";
import {
  overleafConnectForInvocation,
  overleafKeptCopiesForInvocation,
  overleafPreviewForInvocation,
  overleafManageForInvocation,
  overleafSyncForInvocation,
  overleafTokenForInvocation,
  overleafUndoForInvocation,
} from "./handlers.ts";
import { ScientOverleafToolError, ScientOverleafToolkit } from "./tools.ts";

const ENVIRONMENT = EnvironmentId.make("environment-overleaf-tools");
const THREAD = ThreadId.make("thread-overleaf-tools");
const SECRET = "olp_super-secret-token-value";

const invocation = AgentInvocationContext.AgentInvocationContext.of({
  nativeSessionId: "overleaf-tools",
  environmentId: ENVIRONMENT,
  threadId: THREAD,
  issuedAt: 1,
  capabilities: new Set(["documents:build"]),
  // The admitted workspace the dispatcher hands to workspace operations.
  workspace: {
    binding: {
      environmentId: ENVIRONMENT,
      hostProjectId: "project-1",
      trustState: "verified",
      supersededBy: null,
    },
  } as never,
});

const summary = {
  connectionId: "c-1",
  checkoutRoot: "/projects/main",
  folder: "paper",
  projectId: "0123456789abcdef01234567",
  branch: "master" as const,
  state: "active" as const,
  completedSyncCount: 1,
  createdAt: "2026-10-24T00:00:00.000Z",
  updatedAt: "2026-10-24T00:00:00.000Z",
  linkedHere: true,
};

/**
 * Fills what the service always reports and these tests don't vary: a sync that
 * neither retried nor first settled an interrupted sync, unless a test says so.
 */
const withProgress = (name: string, result: unknown) => {
  const value = result as { readonly _tag?: string };
  if (name === "sync" && value._tag !== "duplicate")
    return { retried: false, settled: null, ...value };
  if (name === "preview" && value._tag === "review") return { settled: null, ...value };
  return result;
};

/** A service whose every operation not given fails the test. */
const fakeOverleaf = (overrides: Partial<OverleafSyncShape>): OverleafSyncShape =>
  new Proxy({ list: () => Effect.succeed([summary]), ...overrides } as OverleafSyncShape, {
    get: (target, name: string) => {
      if (!(name in target)) return () => Effect.die(new Error(`unexpected OverleafSync.${name}`));
      const operation = target[name as keyof OverleafSyncShape];
      return typeof operation === "function"
        ? (...args: ReadonlyArray<unknown>) =>
            Effect.map(
              (operation as (...input: ReadonlyArray<unknown>) => Effect.Effect<unknown>)(...args),
              (result) => withProgress(name, result),
            )
        : operation;
    },
  });

const provide =
  (overleaf: OverleafSyncShape) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(AgentInvocationContext.AgentInvocationContext, invocation),
      Effect.provideService(OverleafSync, overleaf),
    );

const encodeToken = Schema.encodeSync(
  Schema.fromJsonString(ScientOverleafToolkit.tools.scient_overleaf_token.successSchema),
);
const encodeError = Schema.encodeSync(
  Schema.fromJsonString(ScientOverleafToolkit.tools.scient_overleaf_token.failureSchema),
);

/**
 * `replan` says only that an apply wrote nothing: never why, and never that the
 * folder lacks the content (it may already hold it).
 */
const infersFromReplan = (line: string) =>
  /changed (here|meanwhile|while)|is not in the folder|not brought in|nothing was restored/iu.test(
    line,
  );

describe("Overleaf tool handlers", () => {
  it.effect(
    "an editor the service could not save is named, with the window that did not answer",
    () =>
      Effect.gen(function* () {
        // The service saves the folder's open editors before any operation that may
        // write it; the tool only says what stopped it.
        const unsaved = new OverleafEditorUnsavedError({
          failures: [
            { path: "paper/main.tex", reason: "unconverted-input" },
            { path: "paper/intro.tex", reason: "save-failed" },
          ],
          unanswered: [{ window: "window-2", reason: "timeout" }],
        });
        const overleaf = fakeOverleaf({
          sync: () => Effect.fail(unsaved) as never,
          restoreKept: () => Effect.fail(unsaved) as never,
          preview: () => Effect.fail(unsaved) as never,
          recover: () => Effect.fail(unsaved) as never,
          keptCopies: () => Effect.succeed([]),
        });
        const calls: ReadonlyArray<
          Effect.Effect<
            unknown,
            ScientOverleafToolError,
            AgentInvocationContext.AgentInvocationContext | OverleafSync
          >
        > = [
          overleafSyncForInvocation({ connectionId: "c-1" }),
          overleafKeptCopiesForInvocation({
            connectionId: "c-1",
            restore: { applyId: "a", kept: "k", keptRevision: "r", currentRevision: null },
          }),
          overleafPreviewForInvocation({ connectionId: "c-1" }),
          overleafManageForInvocation({ connectionId: "c-1", action: "recover" }),
        ];
        for (const call of calls) {
          const failed = yield* Effect.flip(Effect.asVoid(call).pipe(provide(overleaf)));
          expect(failed).toMatchObject({
            code: "editor-save-failed",
            paths: ["paper/main.tex", "paper/intro.tex"],
          });
          // The agent learns which file failed and why, and which window did not answer.
          expect(failed.message).toContain("paper/main.tex (unconverted-input)");
          expect(failed.message).toContain("window window-2 (timeout)");
          expect(failed.message).toContain("Nothing was changed.");
        }
        // Connecting still links; only its first-sync preview is left out, and says why.
        const connected = yield* overleafConnectForInvocation({
          project: "0123456789abcdef01234567",
          mode: "new-folder",
          folder: "paper",
        }).pipe(
          provide(
            fakeOverleaf({
              connect: () =>
                Effect.succeed({
                  _tag: "connected",
                  connection: summary,
                  reconnected: false,
                }) as never,
              preview: () => Effect.fail(unsaved) as never,
            }),
          ),
        );
        expect(connected.firstSync).toBeNull();
        expect(
          connected.lines.some((line) => line.startsWith("The first sync could not be previewed")),
        ).toBe(true);
      }),
  );

  it.effect("undo lists the sends, then says what it put back, what it left and what synced", () =>
    Effect.gen(function* () {
      const asked: unknown[] = [];
      const overleaf = fakeOverleaf({
        undoableSends: () =>
          Effect.succeed([
            {
              attemptNumber: 4,
              recordedAt: "2026-10-24T12:00:00.000Z",
              changes: [
                { kind: "modified", path: "main.tex" },
                { kind: "added", path: "notes.tex" },
              ],
            },
          ]),
        undo: (input: unknown) =>
          Effect.sync(() => {
            asked.push(input);
            return {
              _tag: "undone",
              restored: ["main.tex"],
              removed: [],
              recreated: ["gone.tex"],
              skipped: [{ path: "notes.tex", reason: "changed" }],
              adopted: { outcome: "complete" },
              sync: {
                _tag: "synced",
                review: {
                  reviewId: "r",
                  digest: "d",
                  remoteTree: "b".repeat(40),
                  upToDate: false,
                  needsDecision: false,
                  incoming: [],
                  outgoing: [
                    { kind: "modified", path: "main.tex" },
                    { kind: "added", path: "gone.tex" },
                  ],
                  conflicts: [],
                  warnings: [],
                  unresolvedMarkers: [],
                  released: [],
                  collisions: [],
                  selectedAdditions: [],
                  additions: [],
                  localOnly: [],
                },
                adopted: { outcome: "complete", interrupted: [], markerPaths: [] },
                publication: { _tag: "accepted", attemptNumber: 5 },
                retried: false,
                settled: null,
                activity: [],
                linkedElsewhere: false,
              },
            };
          }) as never,
      } as Partial<OverleafSyncShape>);
      const listed = yield* overleafUndoForInvocation({ connectionId: "c-1" }).pipe(
        provide(overleaf),
      );
      expect(listed.result).toBeNull();
      expect(listed.lines).toEqual([
        "Sends you can undo, newest first:",
        "- send #4 (2026-10-24T12:00:00.000Z): main.tex, notes.tex (new).",
      ]);
      // Listing changes nothing.
      expect(asked).toEqual([]);

      const undone = yield* overleafUndoForInvocation({
        connectionId: "c-1",
        attemptNumber: 4,
        files: { keepOnlyHere: ["private.tex"] },
      }).pipe(provide(overleaf));
      // The sync after the undo carries the per-file decisions, as any sync does.
      expect(asked).toEqual([
        expect.objectContaining({
          connectionId: "c-1",
          attemptNumber: 4,
          files: { keepOnlyHere: ["private.tex"] },
        }),
      ]);
      expect(undone.sends).toBeNull();
      expect(undone.result).toMatchObject({
        _tag: "undone",
        outcome: "complete",
        sync: { _tag: "synced", publication: { _tag: "accepted", attemptNumber: 5 } },
      });
      expect(undone.lines).toEqual([
        "Put back what Overleaf had before send #4: restored main.tex; wrote back gone.tex (the send deleted them). The files it replaced are kept as copies.",
        "Left as it is: notes.tex (edited since that send).",
        "Then it synced:",
        "Sent 2 files to Overleaf (send #5): main.tex, gone.tex (new).",
      ]);

      const refusedWith = (result: unknown) =>
        overleafUndoForInvocation({ connectionId: "c-1", attemptNumber: 4 }).pipe(
          provide(fakeOverleaf({ undo: () => Effect.succeed(result) as never })),
          Effect.map((done) => done.lines),
        );
      expect(yield* refusedWith({ _tag: "cancelled" })).toEqual([
        "The undo of send #4 stopped on request before putting anything back.",
      ]);
      expect(yield* refusedWith({ _tag: "not-eligible", reason: "unresolved" })).toEqual([
        "Overleaf never answered send #4, so what it changed is not known. Nothing changed.",
      ]);
      // An apply that wrote nothing is never reported as put back.
      const replanned = yield* refusedWith({
        _tag: "undone",
        restored: ["main.tex"],
        removed: [],
        recreated: [],
        skipped: [],
        adopted: { outcome: "replan" },
        sync: null,
      });
      expect(replanned).toEqual([
        "The undo of send #4 wrote nothing: the folder changed while it ran. Call again.",
      ]);
    }),
  );

  it.effect("names files held for their conflict marks, even when nothing else would move", () =>
    Effect.gen(function* () {
      const review = {
        reviewId: "r",
        digest: "d",
        remoteTree: "b".repeat(40),
        upToDate: true,
        needsDecision: false,
        incoming: [],
        outgoing: [],
        conflicts: [],
        warnings: [],
        unresolvedMarkers: ["guide.md"],
        released: [],
        collisions: [],
        selectedAdditions: [],
        additions: [],
        localOnly: [],
      };
      const previewed = yield* overleafPreviewForInvocation({ connectionId: "c-1" }).pipe(
        provide(
          fakeOverleaf({ preview: () => Effect.succeed({ _tag: "review", review }) as never }),
        ),
      );
      expect(previewed.lines[0]).toBe("Up to date: nothing would come in or be sent.");
      expect(previewed.lines[1]).toMatch(/^1 file still has conflict marks: guide\.md\./u);
      const stopped = yield* overleafSyncForInvocation({ connectionId: "c-1" }).pipe(
        provide(
          fakeOverleaf({
            sync: () =>
              Effect.succeed({
                _tag: "needs-decision",
                review: {
                  ...review,
                  upToDate: false,
                  needsDecision: true,
                  conflicts: [{ key: "k", paths: ["main.tex"], allowed: ["mine"], chosen: null }],
                },
                activity: [],
                linkedElsewhere: false,
              }) as never,
          }),
        ),
      );
      expect(
        stopped.lines.some((line) => line.startsWith("1 file still has conflict marks: guide.md.")),
      ).toBe(true);
    }),
  );

  it.effect("passes files.release to the service, and says when a release can't be honoured", () =>
    Effect.gen(function* () {
      const asked: unknown[] = [];
      const overleaf = fakeOverleaf({
        sync: (input: unknown) =>
          Effect.sync(() => {
            asked.push(input);
            return { _tag: "refused", refusal: { reason: "release-held", path: "guide.md" } };
          }) as never,
      } as Partial<OverleafSyncShape>);
      const synced = yield* overleafSyncForInvocation({
        connectionId: "c-1",
        files: { release: ["guide.md"] },
      }).pipe(provide(overleaf));
      expect(asked).toEqual([expect.objectContaining({ files: { release: ["guide.md"] } })]);
      expect(synced.lines).toEqual([
        "This sync stopped: guide.md can't be sent as it is: another file held for its conflict marks keeps that place on Overleaf. Settle that file's marks first, or leave it out of files.release.",
      ]);
    }),
  );

  it.effect("maps failures to fixed categories, never Git's text", () =>
    Effect.gen(function* () {
      const failWith = (error: { readonly _tag: string; readonly message: string }) =>
        Effect.flip(
          overleafSyncForInvocation({ connectionId: "c-1" }).pipe(
            provide(fakeOverleaf({ sync: () => Effect.fail(error) as never })),
          ),
        );
      const gitDetail = `fatal: Authentication failed for 'https://git:${SECRET}@git.overleaf.com/x'`;
      const cases: ReadonlyArray<
        readonly [{ readonly _tag: string; readonly message: string }, string]
      > = [
        [
          new OverleafGitError({ reason: "non-zero-exit", exitCode: 128, detail: gitDetail }),
          "overleaf-access-denied",
        ],
        [
          new OverleafGitError({ reason: "timeout", exitCode: null, detail: gitDetail }),
          "overleaf-unreachable",
        ],
        [
          new OverleafGitError({
            reason: "non-zero-exit",
            exitCode: 128,
            detail: `fatal: repository not found ${SECRET}`,
          }),
          "overleaf-project-not-found",
        ],
        [
          new OverleafGitError({ reason: "git-too-old", exitCode: null, detail: gitDetail }),
          "git-unavailable",
        ],
        [
          new OverleafGitError({
            reason: "non-zero-exit",
            exitCode: 1,
            detail: `fatal: odd ${SECRET}`,
          }),
          "failed",
        ],
        [new OverleafRepositoryError({ reason: "unreadable-output", detail: SECRET }), "failed"],
        [new OverleafOperationActiveError({ connectionId: "c-1" }), "operation-active"],
        [
          new OverleafConnectionNotReadyError({ connectionId: "c-1", reason: "recovery-required" }),
          "recovery-required",
        ],
        [new OverleafSyncRefusedError({ reason: "token-missing" }), "token-missing"],
        [new OverleafSyncRefusedError({ reason: "relink-needed" }), "relink-needed"],
        [new OverleafSyncRefusedError({ reason: "access-denied" }), "overleaf-access-denied"],
        [new OverleafSyncRefusedError({ reason: "unreachable" }), "overleaf-unreachable"],
        [new OverleafSyncRefusedError({ reason: "git-failed" }), "failed"],
        [
          new OverleafConnectionNotReadyError({ connectionId: "c-1", reason: "authority-changed" }),
          "connection-changed",
        ],
      ];
      for (const [error, code] of cases) {
        const mapped = yield* failWith(error);
        expect(mapped.code, code).toBe(code);
        expect(encodeError(mapped)).not.toContain(SECRET);
        expect(mapped.message).not.toContain("fatal");
      }
      // A missing token tells the agent how to get one, through the secure request.
      expect(
        (yield* failWith(new OverleafSyncRefusedError({ reason: "token-missing" }))).message,
      ).toContain("request_secret");
    }),
  );

  it.effect("saves the token from a secretRef; the value is in no input, output or error", () =>
    Effect.gen(function* () {
      const saved: string[] = [];
      let removed = 0;
      const consumed: Array<{ readonly ref: string; readonly projectId: string }> = [];
      const overleaf = fakeOverleaf({
        tokenStatus: Effect.sync(() => ({ saved: saved.length > 0 && removed === 0 })),
        saveToken: (token: string) =>
          token.includes(" ")
            ? Effect.fail(new OverleafSyncRefusedError({ reason: "token-missing" }))
            : Effect.sync(() => void saved.push(token)),
        removeToken: Effect.sync(() => void removed++),
      } as Partial<OverleafSyncShape>);
      let value = SECRET;
      const secrets = SecretRequests.of({
        answer: () => Effect.die("unused"),
        savedRef: () => Effect.die("unused"),
        consume: (input) =>
          Effect.suspend(() => {
            consumed.push(input);
            return consumed.length > 2
              ? Effect.fail(new SecretRequestError({ reason: "ref_unavailable" }))
              : Effect.succeed(value);
          }),
      });
      const run = <A, E>(
        effect: Effect.Effect<
          A,
          E,
          | OverleafSync
          | SecretRequests
          | WorkspaceBindingResolver
          | AgentInvocationContext.AgentInvocationContext
        >,
      ) =>
        effect.pipe(
          provide(overleaf),
          Effect.provideService(SecretRequests, secrets),
          Effect.provideService(WorkspaceBindingResolver, workspaceResolverForTest(new Map())),
        );
      const ref = SecretRef.make("secret-ref:0123456789abcdef0123456789abcdef");

      // The tool takes no token: only a reference to a secret the user entered.
      const input = ScientOverleafToolkit.tools.scient_overleaf_token.parametersSchema;
      expect(Object.keys(input.fields)).toEqual(["action", "secretRef"]);

      const result = yield* run(overleafTokenForInvocation({ action: "save", secretRef: ref }));
      expect(saved).toEqual([SECRET]);
      expect(consumed).toEqual([{ ref, projectId: "project-1" }]);
      expect(result.saved).toBe(true);
      expect(encodeToken(result)).not.toContain(SECRET);
      expect(
        encodeToken(yield* run(overleafTokenForInvocation({ action: "status" }))),
      ).not.toContain(SECRET);

      // A value that is not a token is refused without repeating it.
      value = `${SECRET} with spaces`;
      const invalid = yield* Effect.flip(
        run(overleafTokenForInvocation({ action: "save", secretRef: ref })),
      );
      expect(invalid.code).toBe("token-invalid");
      expect(encodeError(invalid)).not.toContain(SECRET);
      // A used reference says so and points back to request_secret.
      const used = yield* Effect.flip(
        run(overleafTokenForInvocation({ action: "save", secretRef: ref })),
      );
      expect(used).toMatchObject({ code: "secret-unavailable" });
      expect(used.message).toContain("request_secret");
      expect((yield* Effect.flip(run(overleafTokenForInvocation({ action: "save" })))).code).toBe(
        "invalid-input",
      );

      const after = yield* run(overleafTokenForInvocation({ action: "remove" }));
      expect(after).toMatchObject({ saved: false });
      expect(removed).toBe(1);
    }),
  );

  it.effect("a thread in another copy is told which copy the link used", () =>
    Effect.gen(function* () {
      const overleaf = fakeOverleaf({
        list: () => Effect.succeed([{ ...summary, linkedHere: false }]),
        sync: () => Effect.succeed({ _tag: "unsettled", reason: "folder-kept-changing" }) as never,
      });
      const synced = yield* overleafSyncForInvocation({ connectionId: "c-1" }).pipe(
        provide(overleaf),
      );
      expect(synced.link).toMatchObject({ checkoutRoot: "/projects/main", linkedElsewhere: true });
      expect(synced.lines[0]).toContain("the copy of the project at /projects/main");
      expect(synced.lines[0]).toContain("not in it until they are merged there");
    }),
  );

  it.effect("manage needs a folder to relink, and recover reports earlier sends", () =>
    Effect.gen(function* () {
      const overleaf = fakeOverleaf({
        recover: () =>
          Effect.succeed({ _tag: "none", attempts: { accepted: [3], unresolved: [4] } }) as never,
      });
      const relink = yield* Effect.flip(
        overleafManageForInvocation({ connectionId: "c-1", action: "relink" }).pipe(
          provide(overleaf),
        ),
      );
      expect(relink.code).toBe("invalid-input");
      const recovered = yield* overleafManageForInvocation({
        connectionId: "c-1",
        action: "recover",
      }).pipe(provide(overleaf));
      const cancelled = yield* overleafManageForInvocation({
        connectionId: "c-1",
        action: "cancel",
      }).pipe(
        provide(
          fakeOverleaf({
            cancel: () => Effect.succeed({ _tag: "requested", operationId: "op" }) as never,
          }),
        ),
      );
      expect(cancelled.lines[0]).toContain("Asked this link's running sync to stop");
      expect(recovered.lines).toEqual([
        "No interrupted sync to settle.",
        "Earlier sends #3 arrived on Overleaf.",
        "Sends #4 still have no answer; Scient never sends them again.",
      ]);
    }),
  );

  it.effect("says when Overleaf moved under the choices, so they don't answer the new review", () =>
    Effect.gen(function* () {
      const review = {
        reviewId: "r",
        digest: "d",
        remoteTree: "b".repeat(40),
        upToDate: false,
        needsDecision: true,
        incoming: [],
        outgoing: [],
        conflicts: [{ key: "k2", paths: ["main.tex"], allowed: ["mine", "theirs"], chosen: null }],
        warnings: [],
        unresolvedMarkers: [],
        released: [],
        collisions: [],
        selectedAdditions: [],
        additions: [],
        localOnly: [],
      };
      const overleaf = fakeOverleaf({
        sync: () =>
          Effect.succeed({
            _tag: "needs-decision",
            review,
            activity: [],
            linkedElsewhere: false,
          }) as never,
      });
      const moved = yield* overleafSyncForInvocation({
        connectionId: "c-1",
        choices: [{ key: "k1", choice: "mine" }],
        reviewedRemote: "a".repeat(40),
      }).pipe(provide(overleaf));
      expect(moved.lines[0]).toContain(
        "Overleaf changed after the review your choices answered, so they don't answer this new review",
      );
      // An earlier attempt may already have applied them: never say they weren't.
      expect(moved.lines.join("\n")).not.toContain("not applied");
      expect(moved.lines).toContain(`- key k2: main.tex; allowed: mine, theirs`);
      const same = yield* overleafSyncForInvocation({
        connectionId: "c-1",
        choices: [{ key: "k1", choice: "mine" }],
        reviewedRemote: "b".repeat(40),
      }).pipe(provide(overleaf));
      expect(same.lines[0]).toBe(
        "Stopped at a conflict before applying this review: none of its changes were applied or sent.",
      );
      // The next call needs the review's Overleaf tree with its choices.
      expect(same.lines[1]).toContain(`reviewedRemote ${"b".repeat(40)}`);
    }),
  );

  it.effect("says a send-related change happened only when Overleaf accepted the send", () =>
    Effect.gen(function* () {
      const review = {
        reviewId: "r",
        digest: "d",
        remoteTree: "b".repeat(40),
        upToDate: false,
        needsDecision: false,
        incoming: [],
        outgoing: [{ kind: "renamed" as const, from: "a.tex", to: "b.tex" }],
        conflicts: [],
        warnings: [
          { kind: "rename", from: "a.tex", to: "b.tex" },
          { kind: "restores-older-version", path: "c.tex" },
        ],
        unresolvedMarkers: [],
        released: [],
        collisions: [],
        selectedAdditions: [],
        additions: [],
        localOnly: [],
      };
      const linesFor = (publication: unknown) =>
        overleafSyncForInvocation({ connectionId: "c-1" }).pipe(
          provide(
            fakeOverleaf({
              sync: () =>
                Effect.succeed({
                  _tag: "synced",
                  review,
                  adopted: {
                    applyId: "x",
                    outcome: "complete",
                    interrupted: [],
                    markerPaths: [],
                    baseGeneration: 1,
                  },
                  publication,
                  retried: false,
                  activity: [],
                  linkedElsewhere: false,
                }) as never,
            }),
          ),
          Effect.map((result) => result.lines),
        );
      const accepted = yield* linesFor({ _tag: "accepted", attemptNumber: 3 });
      expect(accepted.some((line) => line.startsWith("Renamed a.tex → b.tex"))).toBe(true);
      expect(accepted.some((line) => line.startsWith("Sent older versions of 1 file"))).toBe(true);
      const unknown = yield* linesFor({ _tag: "unknown", attemptNumber: 3 });
      expect(unknown.some((line) => line.startsWith("May have renamed a.tex → b.tex"))).toBe(true);
      expect(unknown.some((line) => line.includes("may or may not have arrived"))).toBe(true);
      for (const publication of [
        { _tag: "not-sent", attemptNumber: 3 },
        { _tag: "out-of-date", attemptNumber: 3 },
        { _tag: "blocked", reason: "attention" },
        { _tag: "not-verified" },
      ]) {
        const lines = yield* linesFor(publication);
        expect(
          lines.some((line) => /^(Renamed|Sent|May have)/u.test(line)),
          publication._tag,
        ).toBe(false);
        expect(
          lines.some(
            (line) => line.includes("nothing was sent") || line.startsWith("Nothing was sent"),
          ),
        ).toBe(true);
      }
      // A refused send names the possible causes, not a token change it can't know.
      const refused = yield* linesFor({ _tag: "not-sent", attemptNumber: 3 });
      expect(refused).toContain(
        "Nothing was sent: the folder, the project's workspace or the Overleaf token changed before sending. Sync again.",
      );
    }),
  );

  it.effect("claims incoming changes only when the apply completed", () =>
    Effect.gen(function* () {
      const review = (incoming: ReadonlyArray<unknown>) => ({
        reviewId: "r",
        digest: "d",
        remoteTree: "b".repeat(40),
        upToDate: false,
        needsDecision: false,
        incoming,
        outgoing: [],
        conflicts: [],
        warnings: [],
        unresolvedMarkers: [],
        released: [],
        collisions: [],
        selectedAdditions: [],
        additions: [],
        localOnly: [],
      });
      const linesFor = (
        outcome: string,
        options?: {
          readonly incoming?: ReadonlyArray<unknown>;
          readonly interrupted?: ReadonlyArray<ReadonlyArray<string>>;
          readonly markerPaths?: ReadonlyArray<string>;
        },
      ) =>
        overleafSyncForInvocation({ connectionId: "c-1" }).pipe(
          provide(
            fakeOverleaf({
              sync: () =>
                Effect.succeed({
                  _tag: "synced",
                  review: review(options?.incoming ?? [{ kind: "modified", path: "main.tex" }]),
                  adopted: {
                    applyId: "x",
                    outcome,
                    interrupted: options?.interrupted ?? [],
                    markerPaths: options?.markerPaths ?? [],
                    baseGeneration: 1,
                  },
                  publication: { _tag: "none" },
                  retried: false,
                  activity: [],
                  linkedElsewhere: false,
                }) as never,
            }),
          ),
          Effect.map((result) => result.lines),
        );
      expect((yield* linesFor("complete"))[0]).toBe("1 file came in from Overleaf: main.tex.");
      const replanned = yield* linesFor("replan");
      expect(replanned.some((line) => line.includes("came in"))).toBe(false);
      expect(replanned[0]).toBe(
        "The apply of Overleaf's changes to 1 file (main.tex) wrote nothing to the folder, and a fresh review is needed. Sync again.",
      );
      expect(replanned.some(infersFromReplan)).toBe(false);
      expect((yield* linesFor("replan", { incoming: [] }))[0]).toContain(
        "This apply wrote nothing to the folder",
      );
      const interrupted = yield* linesFor("attention", { interrupted: [["main.tex"]] });
      expect(interrupted.some((line) => line.includes("came in"))).toBe(false);
      expect(interrupted[0]).toContain("applying stopped partway in 1 file group");
      expect(
        (yield* linesFor("attention", { incoming: [], interrupted: [["a.tex"]] }))[0],
      ).toContain("Part of the folder needs attention");
      expect((yield* linesFor("attention", { markerPaths: ["main.tex"] }))[0]).toContain(
        "files have conflict marks",
      );
    }),
  );

  it.effect("names files the rule skips, files kept only here, and files too large to send", () =>
    Effect.gen(function* () {
      const previewed = yield* overleafPreviewForInvocation({ connectionId: "c-1" }).pipe(
        provide(
          fakeOverleaf({
            preview: () =>
              Effect.succeed({
                _tag: "review",
                review: {
                  reviewId: "r",
                  digest: "d",
                  remoteTree: "b".repeat(40),
                  upToDate: true,
                  needsDecision: false,
                  incoming: [],
                  outgoing: [],
                  conflicts: [],
                  warnings: [],
                  unresolvedMarkers: [],
                  released: [],
                  collisions: [],
                  selectedAdditions: [],
                  additions: [
                    { path: "main.aux", size: 4, selected: false, skippedBecause: "build-output" },
                    {
                      path: "data.bin",
                      size: 60_000_000,
                      selected: false,
                      skippedBecause: "too-large",
                    },
                  ],
                  localOnly: ["notes.tex"],
                },
              }) as never,
          }),
        ),
      );
      // An up-to-date preview still says what stays here, and how to send it.
      expect(previewed.lines).toEqual([
        "Up to date: nothing would come in or be sent.",
        "New files not sent by the rule: main.aux (build output). Send one with files.send.",
        "New files over Overleaf's 50 MB limit stay only on this computer: data.bin.",
        "Kept only on this computer: notes.tex. Send one with files.send.",
      ]);
    }),
  );

  it.effect("a restore is reported done only when the copy is back in the folder", () =>
    Effect.gen(function* () {
      const restoreWith = (outcome: string) =>
        overleafKeptCopiesForInvocation({
          connectionId: "c-1",
          restore: { applyId: "a", kept: "k", keptRevision: "r", currentRevision: null },
        }).pipe(
          provide(
            fakeOverleaf({
              keptCopies: () =>
                Effect.succeed([
                  {
                    applyId: "a",
                    kept: "k",
                    relativePath: "main.tex",
                    state: "kept",
                    retainedAt: "2026-10-24T00:00:00.000Z",
                    revision: "r",
                    keptRevision: "r",
                    currentRevision: null,
                    unread: false,
                  },
                ]) as never,
              restoreKept: () =>
                Effect.succeed({ _tag: "restored", adopted: { outcome } }) as never,
            }),
          ),
        );
      const done = yield* restoreWith("complete");
      expect(done.restored).toBe("restored");
      expect(done.lines[0]).toContain("Restored main.tex from its kept copy");
      const replanned = yield* restoreWith("replan");
      expect(replanned.restored).toBe("not-restored");
      expect(replanned.lines[0]).toBe(
        "The restore of main.tex wrote nothing. List the copies again and retry.",
      );
      expect(replanned.lines.some(infersFromReplan)).toBe(false);
      const attention = yield* restoreWith("attention");
      expect(attention.restored).toBe("needs-attention");
      expect(attention.lines[0]).toContain("The restore of main.tex needs attention");
      for (const result of [replanned, attention])
        expect(result.lines.some((line) => line.startsWith("Restored"))).toBe(false);
    }),
  );

  it.effect(
    "after an automatic retry, says the first attempt applied a review and sent nothing",
    () =>
      Effect.gen(function* () {
        const review = (
          incoming: ReadonlyArray<unknown>,
          conflicts: ReadonlyArray<unknown> = [],
        ) => ({
          reviewId: "r",
          digest: "d",
          remoteTree: "b".repeat(40),
          upToDate: false,
          needsDecision: conflicts.length > 0,
          incoming,
          outgoing: [],
          conflicts,
          warnings: [],
          unresolvedMarkers: [],
          released: [],
          collisions: [],
          selectedAdditions: [],
          additions: [],
          localOnly: [],
        });
        const synced = (options: {
          readonly incoming: ReadonlyArray<unknown>;
          readonly retried: boolean;
          readonly publication: unknown;
        }) =>
          overleafSyncForInvocation({ connectionId: "c-1" }).pipe(
            provide(
              fakeOverleaf({
                sync: () =>
                  Effect.succeed({
                    _tag: "synced",
                    review: review(options.incoming),
                    adopted: {
                      applyId: "x",
                      outcome: "complete",
                      interrupted: [],
                      markerPaths: [],
                      baseGeneration: 1,
                    },
                    publication: options.publication,
                    retried: options.retried,
                    activity: [],
                    linkedElsewhere: false,
                  }) as never,
              }),
            ),
            Effect.map((result) => result.lines),
          );
        const retried = yield* synced({
          incoming: [{ kind: "modified", path: "other.tex" }],
          retried: true,
          publication: { _tag: "accepted", attemptNumber: 2 },
        });
        expect(retried[0]).toBe(
          "The first attempt applied a review to the folder, then Overleaf changed while it was sending, so nothing was sent and the sync ran again; the lines below describe the last attempt.",
        );
        expect(retried[1]).toBe("In the last attempt, 1 file came in from Overleaf: other.tex.");
        expect(retried.some((line) => /nothing (was )?applied/iu.test(line))).toBe(false);

        // A first sync: the new file is named, and nothing is said to have been sent.
        const first = yield* synced({
          incoming: [{ kind: "added", path: "main.tex" }],
          retried: false,
          publication: { _tag: "none" },
        });
        expect(first).toEqual(["1 file came in from Overleaf: main.tex (new)."]);

        // Nothing came in, and the folder changed after the apply.
        const unverified = yield* synced({
          incoming: [],
          retried: false,
          publication: { _tag: "not-verified" },
        });
        expect(unverified[0]).toBe(
          "Nothing was sent: the folder changed after the apply. Sync again; the new edit goes with the next sync.",
        );
        expect(unverified.some((line) => line.includes("came in"))).toBe(false);

        // A preview with a conflict names its key, choices and the review's Overleaf tree.
        const previewed = yield* overleafPreviewForInvocation({ connectionId: "c-1" }).pipe(
          provide(
            fakeOverleaf({
              preview: () =>
                Effect.succeed({
                  _tag: "review",
                  review: review(
                    [],
                    [
                      {
                        key: "k",
                        paths: ["main.tex"],
                        allowed: ["mine", "theirs", "markers"],
                        chosen: null,
                      },
                    ],
                  ),
                }) as never,
            }),
          ),
        );
        expect(previewed.lines).toContain(
          `1 conflict to settle. Call again with one choice per key and reviewedRemote ${"b".repeat(40)}:`,
        );
        expect(previewed.lines).toContain("- key k: main.tex; allowed: mine, theirs, markers");
      }),
  );

  it.effect("a stop says what stopped, and what the sync did before it, from the result", () =>
    Effect.gen(function* () {
      const linesFor = (outcome: unknown) =>
        overleafSyncForInvocation({ connectionId: "c-1" }).pipe(
          provide(fakeOverleaf({ sync: () => Effect.succeed(outcome) as never })),
          Effect.map((result) => result.lines),
        );
      const stops = [
        {
          _tag: "refused",
          refusal: { reason: "remote-forbidden", path: "lib", kind: "repository" },
        },
        { _tag: "unsettled", reason: "folder-kept-changing" },
        { _tag: "cancelled", stage: "before-apply" },
      ];
      const STOP = [
        "This sync stopped: Overleaf has content Scient will not write (a link, Git LFS pointer, repository or reserved name) (lib).",
        "The folder kept changing while the sync read it, so it stopped there. Sync again when the edits settle.",
        "The sync stopped on request before applying the review it had built.",
      ];
      for (const [index, stop] of stops.entries()) {
        // Nothing happened before the stop: the stop is the whole result, with no hedge.
        expect(yield* linesFor(stop)).toEqual([STOP[index]]);
        // An interrupted sync finished first, and a retried attempt: both said exactly.
        expect(
          yield* linesFor({
            ...stop,
            retried: true,
            settled: {
              applyId: "s",
              outcome: "complete",
              interrupted: [],
              markerPaths: [],
              baseGeneration: 1,
            },
          }),
        ).toEqual([
          "First finished an interrupted sync: what it was applying is now in the folder.",
          "The first attempt applied a review to the folder, then Overleaf changed while it was sending, so nothing was sent and the sync ran again; the lines below describe the last attempt.",
          STOP[index],
        ]);
      }
      // A preview's refusal is about a sync that hasn't run.
      const previewed = yield* overleafPreviewForInvocation({ connectionId: "c-1" }).pipe(
        provide(
          fakeOverleaf({
            preview: () =>
              Effect.succeed({ _tag: "refused", refusal: { reason: "walk-limit" } }) as never,
          }),
        ),
      );
      expect(previewed.lines).toEqual([
        "A sync can't run now: the folder has more than 5,000 entries. Choose a narrower folder.",
      ]);
      // A refusal still reports the interrupted sync the preview finished first.
      const settledThenRefused = yield* overleafPreviewForInvocation({ connectionId: "c-1" }).pipe(
        provide(
          fakeOverleaf({
            preview: () =>
              Effect.succeed({
                _tag: "refused",
                refusal: { reason: "walk-limit" },
                settled: {
                  applyId: "s",
                  outcome: "attention",
                  interrupted: [],
                  markerPaths: ["main.tex"],
                  baseGeneration: 1,
                },
              }) as never,
          }),
        ),
      );
      expect(settledThenRefused.lines).toEqual([
        "First settled an interrupted sync, but part of the folder needs attention: files have conflict marks. Check scient_overleaf_status, then sync again.",
        "A sync can't run now: the folder has more than 5,000 entries. Choose a narrower folder.",
      ]);
      expect(settledThenRefused.preview).toMatchObject({
        _tag: "refused",
        settled: { outcome: "attention", interrupted: 0, markerPaths: ["main.tex"] },
      });
    }),
  );

  it.effect("recovery says what its own apply established", () =>
    Effect.gen(function* () {
      const recoverWith = (recovered: unknown) =>
        overleafManageForInvocation({ connectionId: "c-1", action: "recover" }).pipe(
          provide(fakeOverleaf({ recover: () => Effect.succeed(recovered) as never })),
        );
      const adopted = (outcome: string, interrupted: ReadonlyArray<unknown> = []) => ({
        _tag: "recovered",
        adopted: { applyId: "a", outcome, interrupted, markerPaths: [], baseGeneration: 1 },
        attempts: { accepted: [], unresolved: [] },
      });
      const complete = yield* recoverWith(adopted("complete"));
      expect(complete.lines).toEqual([
        "Finished an interrupted sync: what it was applying is now in the folder.",
      ]);
      expect(complete.result).toMatchObject({ recovered: true, outcome: "complete" });
      const replanned = yield* recoverWith(adopted("replan"));
      expect(replanned.lines[0]).toBe(
        "Recovered an interrupted sync without writing anything; a fresh review is needed. Sync again.",
      );
      expect(replanned.lines.some(infersFromReplan)).toBe(false);
      expect(replanned.result).toMatchObject({ recovered: true, outcome: "replan" });
      const attention = yield* recoverWith(adopted("attention", [["main.tex"]]));
      expect(attention.lines[0]).toContain(
        "Settled an interrupted sync, but part of the folder needs attention",
      );
      expect(attention.lines[0]).toContain("applying stopped partway in 1 file group");
      for (const result of [replanned, attention])
        expect(result.lines.some((line) => line.startsWith("Finished"))).toBe(false);
      const none = yield* recoverWith({ _tag: "none", attempts: null });
      expect(none.lines).toEqual([
        "No interrupted sync to settle.",
        "Overleaf could not be reached to check earlier sends.",
      ]);
      expect(none.result).toMatchObject({ recovered: false, outcome: null });

      // A preview that settled an interrupted sync first says it may have written the folder.
      let prepared = 0;
      const previewed = yield* overleafPreviewForInvocation({ connectionId: "c-1" }).pipe(
        provide(
          fakeOverleaf({
            preview: () =>
              Effect.sync(() =>
                ++prepared === 1
                  ? {
                      _tag: "recovered",
                      recovery: { outcome: "replan", interrupted: [], markerPaths: [] },
                    }
                  : { _tag: "refused", refusal: { reason: "walk-limit" } },
              ) as never,
          }),
        ),
      );
      expect(previewed.lines.slice(0, 2)).toEqual([
        "First recovered an interrupted sync without writing anything.",
        "A sync can't run now: the folder has more than 5,000 entries. Choose a narrower folder.",
      ]);
      // A review carries what the service settled before building it.
      const reviewed = yield* overleafPreviewForInvocation({ connectionId: "c-1" }).pipe(
        provide(
          fakeOverleaf({
            preview: () =>
              Effect.succeed({
                _tag: "review",
                settled: {
                  applyId: "s",
                  outcome: "complete",
                  interrupted: [],
                  markerPaths: [],
                  baseGeneration: 1,
                },
                review: {
                  reviewId: "r",
                  digest: "d",
                  remoteTree: "b".repeat(40),
                  upToDate: true,
                  needsDecision: false,
                  incoming: [],
                  outgoing: [],
                  conflicts: [],
                  warnings: [],
                  unresolvedMarkers: [],
                  released: [],
                  collisions: [],
                  selectedAdditions: [],
                  additions: [],
                  localOnly: [],
                },
              }) as never,
          }),
        ),
      );
      expect(reviewed.lines).toEqual([
        "First finished an interrupted sync: what it was applying is now in the folder.",
        "Up to date: nothing would come in or be sent.",
      ]);
      expect(reviewed.preview).toMatchObject({
        settled: { outcome: "complete", interrupted: 0, markerPaths: [] },
      });
    }),
  );

  it.effect("recovery from another worktree names the copy it changed", () =>
    Effect.gen(function* () {
      const recovered = yield* overleafManageForInvocation({
        connectionId: "c-1",
        action: "recover",
      }).pipe(
        provide(
          fakeOverleaf({
            list: () =>
              Effect.succeed([{ ...summary, checkoutRoot: "/projects/main", linkedHere: false }]),
            recover: () =>
              Effect.succeed({
                _tag: "recovered",
                adopted: { outcome: "complete", interrupted: [], markerPaths: [] },
                attempts: { accepted: [], unresolved: [] },
              }) as never,
          }),
        ),
      );
      expect(recovered.link).toMatchObject({
        checkoutRoot: "/projects/main",
        folder: "paper",
        linkedElsewhere: true,
      });
      expect(recovered.lines[0]).toContain("the copy of the project at /projects/main");
      expect(recovered.lines[1]).toBe(
        "Finished an interrupted sync: what it was applying is now in the folder.",
      );
    }),
  );
});
