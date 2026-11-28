// @effect-diagnostics nodeBuiltinImport:off -- Issued files are real files in a temporary folder.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import {
  BrowserProfileId,
  EnvironmentId,
  ProjectId,
  ThreadId,
  type PreviewAutomationStatus,
} from "@t3tools/contracts";
import { Deferred, Effect, Fiber, Stream } from "effect";
import { makeHarness } from "./Accounts.testkit.ts";
import { AccountsService } from "./AccountsService.ts";
import { profileGrant } from "./accessChanges.ts";
import { authorizePreviewProfile } from "./agent/previewProfileAccess.ts";
import { makeSessionFiles, revokeIssuedFiles } from "./agent/sessionFiles.ts";

const lab = BrowserProfileId.make("profile-lab");
const chat = ThreadId.make("thread-admission");
const scope = { threadId: chat, projectId: ProjectId.make("project-lab"), unattended: false };
const status: PreviewAutomationStatus = {
  available: true,
  visible: false,
  tabId: null,
  url: null,
  title: null,
  loading: false,
  profiles: [{ id: lab, name: "Lab" }],
  tabs: [],
};

describe("a removed profile can't be opened again (round 6c, finding 1)", () => {
  it.effect("is refused to an agent that names it, as an old client still lists it", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      yield* service.reportProfiles([{ profileId: lab, name: "Lab" }]);
      const open = authorizePreviewProfile(scope, status, {
        profileId: lab,
        reuseExistingTab: false,
      }).pipe(Effect.provideService(AccountsService, service));
      expect((yield* open).profileId).toBe(lab);
      yield* service.operateProfile(
        { operationId: "op-remove", kind: "remove", profileId: lab },
        undefined,
        [],
      );
      expect((yield* Effect.flip(open)).reason).toBe("denied");
      // Undo brings it back for agents too.
      yield* service.undoProfileOperation("op-remove", undefined);
      expect((yield* open).profileId).toBe(lab);
    }),
  );

  it.effect("counts a tab still opening, so a Remove meanwhile refuses and names its chat", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const opening = yield* Deferred.make<void>();
      const opened = yield* Deferred.make<void>();
      const fiber = yield* service
        .admitProfileTab(
          lab,
          chat,
          Deferred.succeed(opening, undefined).pipe(Effect.andThen(Deferred.await(opened))),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(opening);
      // The open hasn't registered its tab yet: the permit still sees it.
      const refused = yield* service.operateProfile(
        { operationId: "op-early", kind: "remove", profileId: lab },
        undefined,
        Effect.succeed([]),
      );
      expect(refused.refused).toMatchObject({ reason: "open-tabs", threadIds: [chat] });
      yield* Deferred.succeed(opened, undefined);
      yield* Fiber.join(fiber);
      const removed = yield* service.operateProfile(
        { operationId: "op-remove", kind: "remove", profileId: lab },
        undefined,
        Effect.succeed([]),
      );
      expect(removed.operation?.kind).toBe("remove");
      // Removed: a new open is refused before it starts.
      const late = yield* Effect.flip(service.admitProfileTab(lab, chat, Effect.void));
      expect(late.reason).toBe("denied");
    }),
  );

  it.effect("takes back files issued from it once it is cleared or removed", () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "accounts-admit-"))),
        (root) => Effect.promise(() => NodeFSP.rm(root, { recursive: true, force: true })),
      );
      const { service } = yield* makeHarness();
      yield* service.reportProfiles([{ profileId: lab, name: "Lab" }]);
      const files = yield* makeSessionFiles(root, service.snapshot);
      const record = (yield* service.snapshot).profiles.find(({ profileId }) => profileId === lab)!;
      const issue = Effect.gen(function* () {
        const [file] = yield* files.issue(
          yield* files.begin(chat),
          [profileGrant(record)],
          [["lab-cookies.txt", "synthetic"]],
        );
        return file!;
      });
      const exists = (file: string) =>
        Effect.promise(() =>
          NodeFSP.stat(file).then(
            () => true,
            () => false,
          ),
        );
      const cleared = yield* issue;
      const before = yield* service.snapshot;
      yield* service.operateProfile(
        { operationId: "op-clear", kind: "clear", profileId: lab },
        undefined,
        [],
      );
      yield* revokeIssuedFiles(root, Stream.make(before, yield* service.snapshot));
      expect(yield* exists(cleared)).toBe(false);
      // Issued again in the new data, then removed: taken back too, after a restart as well.
      const fresh = (yield* service.snapshot).profiles.find(({ profileId }) => profileId === lab)!;
      const [kept] = yield* files.issue(
        yield* files.begin(chat),
        [profileGrant(fresh)],
        [["lab-cookies.txt", "synthetic"]],
      );
      yield* service.operateProfile(
        { operationId: "op-remove", kind: "remove", profileId: lab },
        undefined,
        [],
      );
      yield* revokeIssuedFiles(root, Stream.make(yield* service.snapshot));
      expect(yield* exists(kept!)).toBe(false);
    }),
  );

  it.effect("takes its sign-ins back from the computers it is sent to, and Undo sends them", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      yield* service.reportProfiles([{ profileId: lab, name: "Lab" }]);
      yield* service.profileShared(lab, {
        environmentId: EnvironmentId.make("env-remote"),
        label: "Lab server",
        applied: 0,
        waiting: 0,
        needsYou: [],
      });
      yield* service.operateProfile(
        { operationId: "op-remove", kind: "remove", profileId: lab },
        undefined,
        [],
      );
      const removed = yield* service.profileSendLog(lab);
      expect(removed.withdrawn).toBe(removed.head);
      yield* service.undoProfileOperation("op-remove", undefined);
      const back = yield* service.profileSendLog(lab);
      expect(back.jar).toBe(back.head);
      expect(back.head).toBeGreaterThan(removed.head);
      // A Clear sends the whole jar again, as it now is.
      yield* service.operateProfile(
        { operationId: "op-clear", kind: "clear", profileId: lab },
        undefined,
        [],
      );
      const cleared = yield* service.profileSendLog(lab);
      expect(cleared.jar).toBe(cleared.head);
      expect(cleared.head).toBeGreaterThan(back.head);
    }),
  );
});
