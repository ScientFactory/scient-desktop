import {
  BrowserProfileId,
  DEFAULT_BROWSER_PROFILE_ID,
  ProjectId,
  ThreadId,
  defaultBrowserProfileRecord,
  type PreviewAutomationStatus,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import { AccountsService } from "../AccountsService.ts";
import { makeHarness } from "../AccountsTestkit.ts";
import { fakeAccounts } from "./AccountsService.testkit.ts";
import { authorizePreviewProfile, filterPreviewProfiles } from "./previewProfileAccess.ts";

const scope = {
  threadId: ThreadId.make("thread-fixture"),
  projectId: ProjectId.make("project-fixture"),
  unattended: false,
};
const defaultId = BrowserProfileId.make("default");
const workId = BrowserProfileId.make("work");
const status: PreviewAutomationStatus = {
  available: true,
  visible: false,
  tabId: "tab-current",
  url: null,
  title: null,
  loading: false,
  defaultProfileId: defaultId,
  profiles: [
    { id: defaultId, name: "Default" },
    { id: workId, name: "Work" },
  ],
  tabs: [{ tabId: "tab-current", url: null, profileId: workId, ownedByCaller: true }],
};

it.effect(
  "resolves actual reused profiles, names and the denied default before browser open; script export needs its separate permission",
  () =>
    Effect.gen(function* () {
      const fake = fakeAccounts({
        profiles: [
          defaultBrowserProfileRecord(defaultId),
          { ...defaultBrowserProfileRecord(workId), scriptSignIn: false },
        ],
      });
      const run = <A, E>(effect: Effect.Effect<A, E, AccountsService>) =>
        effect.pipe(Effect.provideService(AccountsService, fake.service));
      expect((yield* run(authorizePreviewProfile(scope, status, {}))).profileId).toBe(workId);
      expect(
        (yield* run(
          authorizePreviewProfile(scope, status, { profileId: "Work", reuseExistingTab: false }),
        )).profileId,
      ).toBe(workId);
      expect(
        (yield* run(authorizePreviewProfile(scope, status, { reuseExistingTab: false }))).profileId,
      ).toBe(defaultId);
      expect(
        (yield* Effect.flip(
          run(
            authorizePreviewProfile(scope, status, {
              profileId: "missing",
              reuseExistingTab: false,
            }),
          ),
        )).message,
      ).toContain("could not be resolved");
      expect(
        (yield* Effect.flip(
          run(
            authorizePreviewProfile(
              scope,
              status,
              { profileId: workId, reuseExistingTab: false },
              "browser-session",
            ),
          ),
        )).message,
      ).toContain("Script sign-ins");
      const denied = fakeAccounts({ denied: true });
      expect(
        (yield* Effect.flip(
          authorizePreviewProfile(scope, status, { reuseExistingTab: false }).pipe(
            Effect.provideService(AccountsService, denied.service),
          ),
        )).message,
      ).toContain("unavailable");
    }),
);

it.effect(
  "omits off and out-of-scope profiles and a blocked default, while honoring the global switch",
  () =>
    Effect.gen(function* () {
      const fake = fakeAccounts({
        profiles: [
          { ...defaultBrowserProfileRecord(defaultId), access: "off" },
          defaultBrowserProfileRecord(workId),
        ],
      });
      const filtered = yield* filterPreviewProfiles(scope, status).pipe(
        Effect.provideService(AccountsService, fake.service),
      );
      expect(filtered.profiles).toEqual([{ id: workId, name: "Work" }]);
      expect(filtered.defaultProfileId).toBeUndefined();
      const disabled = fakeAccounts({
        agentAccess: false,
        profiles: [defaultBrowserProfileRecord(workId)],
      });
      expect(
        (yield* filterPreviewProfiles(scope, status).pipe(
          Effect.provideService(AccountsService, disabled.service),
        )).profiles,
      ).toEqual([]);
    }),
);

it.effect("keeps unrecorded named profiles from the browser inventory discoverable", () =>
  Effect.gen(function* () {
    const { service } = yield* makeHarness();
    const filtered = yield* filterPreviewProfiles(scope, status).pipe(
      Effect.provideService(AccountsService, service),
    );
    expect(filtered.profiles).toEqual(status.profiles);
  }).pipe(Effect.scoped),
);

it.effect(
  "opens the built-in default on a cold browser without a defaultProfileId while enforcing its access",
  () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const cold: PreviewAutomationStatus = {
        available: true,
        visible: false,
        tabId: null,
        url: null,
        title: null,
        loading: false,
      };
      const open = authorizePreviewProfile(scope, cold, {}).pipe(
        Effect.provideService(AccountsService, service),
      );
      expect((yield* open).profileId).toBe(DEFAULT_BROWSER_PROFILE_ID);
      yield* service.setControls({
        target: { type: "profile", profileId: DEFAULT_BROWSER_PROFILE_ID },
        access: "off",
      });
      expect((yield* Effect.flip(open)).reason).toBe("denied");
    }).pipe(Effect.scoped),
);
