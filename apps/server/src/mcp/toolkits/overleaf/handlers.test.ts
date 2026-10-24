/**
 * The Overleaf tools against a fake service, where real Git is not the point:
 * the editor save that comes first, errors as fixed categories, and the token
 * flow through a secretRef. The real service runs in handlers.git.test.ts.
 */
import { EnvironmentId, SecretRef, SecretRequestError, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as AgentInvocationContext from "../../../scient/operations/AgentInvocationContext.ts";
import {
  OverleafEditorSave,
  type OverleafEditorSaveResult,
} from "../../../scient/overleaf/OverleafEditorSave.ts";
import { recordingEditorSave } from "../../../scient/overleaf/OverleafEditorSave.testkit.ts";
import {
  OverleafConnectionNotReadyError,
  OverleafOperationActiveError,
} from "../../../scient/overleaf/OverleafCoordinator.ts";
import { OverleafGitError } from "../../../scient/overleaf/OverleafGitExecutor.ts";
import { OverleafRepositoryError } from "../../../scient/overleaf/OverleafRepository.ts";
import {
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
} from "./handlers.ts";
import { ScientOverleafToolkit } from "./tools.ts";

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

/** A service whose every operation not given fails the test. */
const fakeOverleaf = (overrides: Partial<OverleafSyncShape>): OverleafSyncShape =>
  new Proxy({ list: () => Effect.succeed([summary]), ...overrides } as OverleafSyncShape, {
    get: (target, name: string) =>
      name in target
        ? target[name as keyof OverleafSyncShape]
        : () => Effect.die(new Error(`unexpected OverleafSync.${name}`)),
  });

const provide =
  (overleaf: OverleafSyncShape, saver = recordingEditorSave({ _tag: "saved" }).service) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(AgentInvocationContext.AgentInvocationContext, invocation),
      Effect.provideService(OverleafSync, overleaf),
      Effect.provideService(OverleafEditorSave, saver),
    );

const encodeToken = Schema.encodeSync(
  Schema.fromJsonString(ScientOverleafToolkit.tools.scient_overleaf_token.successSchema),
);
const encodeError = Schema.encodeSync(
  Schema.fromJsonString(ScientOverleafToolkit.tools.scient_overleaf_token.failureSchema),
);

describe("Overleaf tool handlers", () => {
  it.effect("a failed editor save stops every call that may write before anything changes", () =>
    Effect.gen(function* () {
      let changed = 0;
      const overleaf = fakeOverleaf({
        sync: () => Effect.sync(() => changed++) as never,
        restoreKept: () => Effect.sync(() => changed++) as never,
        // Preparing and recovering can finish an interrupted apply, which writes.
        preview: () => Effect.sync(() => changed++) as never,
        recover: () => Effect.sync(() => changed++) as never,
        keptCopies: () => Effect.succeed([]),
      });
      const outcomes: ReadonlyArray<OverleafEditorSaveResult> = [
        {
          _tag: "failed",
          failures: [
            { path: "paper/main.tex", reason: "unconverted-input" },
            { path: "paper/intro.tex", reason: "save-failed" },
          ],
          unanswered: [],
        },
        { _tag: "failed", failures: [], unanswered: [{ window: "window-2", reason: "timeout" }] },
        { _tag: "unavailable" },
      ];
      for (const outcome of outcomes) {
        const saver = recordingEditorSave(outcome);
        const synced = yield* Effect.flip(
          overleafSyncForInvocation({ connectionId: "c-1" }).pipe(provide(overleaf, saver.service)),
        );
        expect(synced).toMatchObject({ code: "editor-save-failed" });
        expect(synced.message).toContain("Nothing was synced.");
        expect(saver.calls).toEqual([{ checkoutRoot: "/projects/main", folder: "paper" }]);
        const restored = yield* Effect.flip(
          overleafKeptCopiesForInvocation({
            connectionId: "c-1",
            restore: { applyId: "a", kept: "k", keptRevision: "r", currentRevision: null },
          }).pipe(provide(overleaf, saver.service)),
        );
        expect(restored).toMatchObject({ code: "editor-save-failed" });
        expect(restored.message).toContain("Nothing was restored.");
        const previewed = yield* Effect.flip(
          overleafPreviewForInvocation({ connectionId: "c-1" }).pipe(
            provide(overleaf, saver.service),
          ),
        );
        expect(previewed).toMatchObject({ code: "editor-save-failed" });
        const recovered = yield* Effect.flip(
          overleafManageForInvocation({ connectionId: "c-1", action: "recover" }).pipe(
            provide(overleaf, saver.service),
          ),
        );
        expect(recovered).toMatchObject({ code: "editor-save-failed" });
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
              preview: () => Effect.sync(() => changed++) as never,
            }),
            saver.service,
          ),
        );
        expect(connected.firstSync).toBeNull();
        expect(
          connected.lines.some((line) => line.startsWith("The first sync could not be previewed")),
        ).toBe(true);
      }
      const first = yield* Effect.flip(
        overleafSyncForInvocation({ connectionId: "c-1" }).pipe(
          provide(overleaf, recordingEditorSave(outcomes[0]!).service),
        ),
      );
      // The agent learns which file failed, and why.
      expect(first.message).toContain("paper/main.tex (unconverted-input)");
      // A window that did not answer is named too.
      const silent = yield* Effect.flip(
        overleafSyncForInvocation({ connectionId: "c-1" }).pipe(
          provide(overleaf, recordingEditorSave(outcomes[1]!).service),
        ),
      );
      expect(silent.message).toContain("window window-2 (timeout)");
      expect(first.paths).toEqual(["paper/main.tex", "paper/intro.tex"]);
      expect(changed).toBe(0);
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
          | OverleafEditorSave
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
        "No interrupted sync to finish.",
        "Earlier sends #3 arrived on Overleaf.",
        "Sends #4 still have no answer; Scient never sends them again.",
      ]);
    }),
  );

  it.effect("says when Overleaf moved under the choices, so they were not applied", () =>
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
      expect(moved.lines[0]).toContain("Overleaf changed since the review your choices answered");
      expect(moved.lines).toContain(`- key k2: main.tex; allowed: mine, theirs`);
      const same = yield* overleafSyncForInvocation({
        connectionId: "c-1",
        choices: [{ key: "k1", choice: "mine" }],
        reviewedRemote: "b".repeat(40),
      }).pipe(provide(overleaf));
      expect(same.lines[0]).toBe(
        "Stopped at a conflict before applying: none of this review's changes were applied or sent.",
      );
      // The next call needs the review's Overleaf tree with its choices.
      expect(same.lines[1]).toContain(`reviewedRemote ${"b".repeat(40)}`);
    }),
  );

  it.effect(
    "names the saved folder, and when a relink moved it, saves the new one and retries once",
    () =>
      Effect.gen(function* () {
        const folders = ["paper", "papers/paper"];
        let listed = 0;
        const asked: unknown[] = [];
        const overleaf = fakeOverleaf({
          list: () => Effect.sync(() => [{ ...summary, folder: folders[Math.min(listed++, 1)]! }]),
          sync: (input: { readonly savedFolder?: unknown }) =>
            Effect.suspend(() => {
              asked.push(input.savedFolder);
              return asked.length === 1
                ? Effect.fail(new OverleafSyncRefusedError({ reason: "folder-changed" }))
                : Effect.succeed({ _tag: "unsettled", reason: "folder-kept-changing" });
            }) as never,
        } as Partial<OverleafSyncShape>);
        const saver = recordingEditorSave({ _tag: "saved" });
        const synced = yield* overleafSyncForInvocation({ connectionId: "c-1" }).pipe(
          provide(overleaf, saver.service),
        );
        expect(synced.result._tag).toBe("unsettled");
        expect(saver.calls.map((call) => call.folder)).toEqual(["paper", "papers/paper"]);
        expect(asked).toEqual([
          { checkoutRoot: "/projects/main", folder: "paper" },
          { checkoutRoot: "/projects/main", folder: "papers/paper" },
        ]);
        expect(synced.link.folder).toBe("papers/paper");

        // A second move is reported, not chased.
        let tries = 0;
        const restless = fakeOverleaf({
          sync: () =>
            Effect.suspend(() => {
              tries++;
              return Effect.fail(new OverleafSyncRefusedError({ reason: "folder-changed" }));
            }) as never,
        });
        const moved = yield* Effect.flip(
          overleafSyncForInvocation({ connectionId: "c-1" }).pipe(provide(restless)),
        );
        expect(moved.code).toBe("connection-changed");
        expect(moved.message).toContain("Nothing was synced.");
        expect(tries).toBe(2);
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
      expect(replanned[0]).toContain("were not brought in: a file here changed");
      expect((yield* linesFor("replan", { incoming: [] }))[0]).toContain(
        "nothing was written to the folder",
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

  it.effect("a restore or preview after a relink reports the folder it ran in", () =>
    Effect.gen(function* () {
      const moved = {
        ...summary,
        checkoutRoot: "/projects/main-2",
        folder: "moved-paper",
        linkedHere: false,
      };
      // The first `staleLists` lookups see `paper`; the relink lands before the retry.
      const relinking = (operation: Partial<OverleafSyncShape>, staleLists: number) => {
        let listed = 0;
        let calls = 0;
        return fakeOverleaf({
          list: () => Effect.sync(() => [++listed <= staleLists ? summary : moved]),
          keptCopies: () => Effect.succeed([]),
          ...Object.fromEntries(
            Object.entries(operation).map(([name, succeed]) => [
              name,
              () =>
                Effect.suspend(() =>
                  ++calls === 1
                    ? Effect.fail(new OverleafSyncRefusedError({ reason: "folder-changed" }))
                    : (succeed as () => Effect.Effect<unknown>)(),
                ),
            ]),
          ),
        } as Partial<OverleafSyncShape>);
      };
      const restored = yield* overleafKeptCopiesForInvocation({
        connectionId: "c-1",
        restore: { applyId: "a", kept: "k", keptRevision: "r", currentRevision: null },
      }).pipe(
        // The restore looks the link up once before its save, then once per attempt.
        provide(
          relinking(
            {
              restoreKept: () =>
                Effect.succeed({ _tag: "restored", adopted: { outcome: "complete" } }),
            } as never,
            2,
          ),
        ),
      );
      expect(restored.restored).toBe("restored");
      expect(restored.link).toMatchObject({
        folder: "moved-paper",
        checkoutRoot: "/projects/main-2",
      });
      expect(restored.lines[0]).toContain("the copy of the project at /projects/main-2");

      const previewed = yield* overleafPreviewForInvocation({ connectionId: "c-1" }).pipe(
        provide(
          relinking(
            {
              preview: () => Effect.succeed({ _tag: "refused", refusal: { reason: "walk-limit" } }),
            } as never,
            1,
          ),
        ),
      );
      expect(previewed.link.folder).toBe("moved-paper");
      expect(previewed.lines[0]).toContain("the copy of the project at /projects/main-2");
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
        "Nothing was restored: main.tex changed here meanwhile, so nothing was written. List the copies again and retry.",
      );
      const attention = yield* restoreWith("attention");
      expect(attention.restored).toBe("needs-attention");
      expect(attention.lines[0]).toContain("The restore of main.tex needs attention");
      for (const result of [replanned, attention])
        expect(result.lines.some((line) => line.startsWith("Restored"))).toBe(false);
    }),
  );

  it.effect("after an automatic retry, says the earlier attempt already brought changes in", () =>
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
      expect(retried[0]).toContain(
        "An earlier attempt had already brought Overleaf's changes into the folder",
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
});
