import { describe, expect, it } from "@effect/vitest";
import {
  AccountId,
  BrowserProfileId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  PROFILE_IMPORT_CAUSE_COPY,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { TestClock } from "effect/testing";
import { libraryKeyFits } from "@t3tools/shared/scientLibraryKeys";
import { ProjectionStoreV2 } from "../../../orchestration-v2/ProjectionStore.ts";
import { ScheduledTaskService } from "../../../scheduledTasks/ScheduledTaskService.ts";
import { AgentInvocationContext } from "../../operations/AgentInvocationContext.ts";
import { AccountsService } from "../AccountsService.ts";
import { makeHarness, syntheticValue, website } from "../Accounts.testkit.ts";
import { manageAccount, manageBrowserProfiles } from "./accountManage.ts";
import { ScientAccountsToolkit } from "./tools.ts";

const threadId = ThreadId.make("thread-manage");
const projectId = ProjectId.make("project-manage");

/** Runs an agent's call in a chat of this project, against the real Accounts service. */
const asAgent = <A, E>(
  service: AccountsService["Service"],
  effect: Effect.Effect<A, E, AccountsService | AgentInvocationContext | ProjectionStoreV2>,
) =>
  effect.pipe(
    Effect.provideService(AccountsService, service),
    Effect.provideService(AgentInvocationContext, {
      environmentId: EnvironmentId.make("env-manage"),
      threadId,
      providerSessionId: "session-manage",
      providerInstanceId: ProviderInstanceId.make("codex"),
      capabilities: new Set(["accounts"] as const),
      issuedAt: 0,
    }),
    Effect.provideService(ProjectionStoreV2, {
      getThreadRecords: () => Effect.succeed({ thread: { projectId }, runs: [], messages: [] }),
    } as never),
  );
const noCheck = () => Effect.succeed({ state: "unknown" });

/** The laptop's own server: an import reads only browsers on its own desktop (round 6f). */
const laptopServer = {
  desktop: true,
  computer: { id: "env-laptop", label: "Ada's laptop" },
  generations: () => Effect.void,
  closeProfile: () => Effect.void,
  signOut: () => Effect.succeed({ cookies: [] }),
  restore: () => Effect.succeed({ restored: 0, refused: 0 }),
  copy: () => Effect.succeed({ copied: 0, uncovered: [], sites: [] }),
  restoreInto: () => Effect.succeed({ restored: 0, refused: 0 }),
  purge: () => Effect.void,
};

describe("an agent managing accounts (AMENDMENTS 56)", () => {
  it.effect("pins only this project's tasks, never a webhook one, and says when it didn't", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const { accountId } = yield* service.save(website());
      const tasks = [
        { id: "task:here", projectId, schedule: { type: "interval" } },
        { id: "task:hook", projectId, schedule: { type: "webhook" } },
        {
          id: "task:theirs",
          projectId: ProjectId.make("project-other"),
          schedule: { type: "interval" },
        },
      ];
      const scheduler = Layer.mock(ScheduledTaskService)({
        list: () => Effect.succeed({ tasks } as never),
      });
      const pin = (scheduledTaskId: string) =>
        asAgent(
          service,
          manageAccount({ action: "pin_task", accountId, scheduledTaskId }, noCheck),
        ).pipe(Effect.provide(scheduler));
      yield* pin("task:here");
      // regression: a webhook task took a pin whose skipped deliveries could never run again.
      expect((yield* pin("task:hook").pipe(Effect.flip)).reason).toBe("invalid-input");
      // regression: another project's task looked pinned, though nothing was written.
      expect((yield* pin("task:theirs").pipe(Effect.flip)).reason).toBe("not-found");
      expect((yield* service.taskPins).map((kept) => kept.scheduledTaskId)).toEqual(["task:here"]);
    }),
  );

  it.effect("edits at the version it read, never widening where a key goes", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const { accountId } = yield* service.save({
        name: "Lab key",
        details: {
          kind: "api-key",
          sites: ["https://api.a.example", "https://api.b.example"],
          auth: { type: "bearer" },
        },
        secrets: { token: { type: "scient", value: syntheticValue() } },
      });
      const manage = (input: Parameters<typeof manageAccount>[0]) =>
        asAgent(service, manageAccount(input, noCheck));
      const read = yield* manage({ action: "get", accountId });
      const version = read.account!.version;
      // A stale version is refused.
      expect(
        (yield* manage({
          action: "edit",
          accountId,
          version: "2020-01-01T00:00:00.000Z",
          name: "X",
        }).pipe(Effect.flip)).reason,
      ).toBe("conflict");
      // A key is never sent to a new site by an agent.
      expect(
        (yield* manage({
          action: "edit",
          accountId,
          version,
          sites: ["https://api.c.example"],
        }).pipe(Effect.flip)).reason,
      ).toBe("denied");
      const edited = yield* manage({
        action: "edit",
        accountId,
        version,
        name: "Lab key (A)",
        sites: ["https://api.a.example"],
      });
      expect(edited.account).toMatchObject({
        name: "Lab key (A)",
        sites: ["https://api.a.example"],
      });
      // The person sees what this chat changed.
      expect((yield* service.snapshot).changes).toEqual([
        expect.objectContaining({ change: "edit", threadId, projectId, detail: "Lab key (A)" }),
      ]);
    }),
  );

  it.effect("never renames a key's variable, which could make Zotero pick it", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const { accountId } = yield* service.save({
        name: "Lab key",
        details: { kind: "api-key", sites: ["https://api.a.example"], auth: { type: "bearer" } },
        secrets: { token: { type: "scient", value: syntheticValue() } },
      });
      const zoteroCandidates = Effect.map(service.snapshot, ({ accounts }) =>
        accounts.filter((account) => libraryKeyFits("zotero", account)),
      );
      expect(yield* zoteroCandidates).toEqual([]);
      const { updatedAt } = (yield* service.snapshot).accounts.find(
        (account) => account.accountId === accountId,
      )!;
      // regression: ZOTERO_API_KEY made a key for another service Zotero's.
      const refused = yield* service
        .agentEdit(accountId, updatedAt, { envName: "ZOTERO_API_KEY" }, { threadId })
        .pipe(Effect.flip);
      expect(refused.reason).toBe("denied");
      expect(yield* zoteroCandidates).toEqual([]);
    }),
  );

  it.effect("only tightens controls, and leaves an Off account to the person", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const { accountId } = yield* service.save(website());
      const manage = (input: Parameters<typeof manageAccount>[0]) =>
        asAgent(service, manageAccount(input, noCheck));
      const { version } = (yield* manage({ action: "get", accountId })).account!;
      yield* manage({ action: "controls", accountId, version, access: "ask", scope: [projectId] });
      const tightened = (yield* service.snapshot).accounts[0]!.controls;
      expect(tightened).toMatchObject({
        access: "ask",
        scope: { type: "projects", projectIds: [projectId] },
      });
      // Loosening is refused at commit, whatever the agent read.
      const now = (yield* manage({ action: "get", accountId })).account!.version;
      expect(
        (yield* service
          .agentControls({ target: { type: "account", accountId }, access: "allowed" }, now, {
            threadId,
            projectId,
          })
          .pipe(Effect.flip)).reason,
      ).toBe("denied");
      expect(
        (yield* service
          .agentControls(
            { target: { type: "account", accountId }, scope: { type: "all-projects" } },
            now,
            { threadId, projectId },
          )
          .pipe(Effect.flip)).reason,
      ).toBe("denied");
      const again = (yield* manage({ action: "get", accountId })).account!.version;
      yield* manage({ action: "controls", accountId, version: again, access: "off" });
      // Off is the person's: no edit or remove.
      const offVersion = (yield* manage({ action: "get", accountId })).account!.version;
      expect(
        (yield* manage({ action: "remove", accountId, version: offVersion }).pipe(Effect.flip))
          .reason,
      ).toBe("denied");
    }),
  );

  it.effect("rechecks the version, Off and scope when a write commits", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const { accountId } = yield* service.save(website());
      const manage = (input: Parameters<typeof manageAccount>[0]) =>
        asAgent(service, manageAccount(input, noCheck));
      const { version } = (yield* manage({ action: "get", accountId })).account!;
      // regression: the person turns it Off after the agent read it; the agent's tighten,
      // remove and save offer, at the version it read, no longer commit.
      yield* service.setControls({ target: { type: "account", accountId }, access: "off" });
      const by = { threadId, projectId };
      const refused = [
        yield* service
          .agentControls(
            { target: { type: "account", accountId }, scriptSignIn: false },
            version,
            by,
          )
          .pipe(Effect.flip),
        yield* service.agentRemove(accountId, version, by).pipe(Effect.flip),
        yield* service.agentSaveOffer(accountId, version, by).pipe(Effect.flip),
      ].map(({ reason }) => reason);
      expect(refused.every((reason) => reason === "denied" || reason === "conflict")).toBe(true);
      expect((yield* service.snapshot).accounts.map((account) => account.accountId)).toEqual([
        accountId,
      ]);
      // Out of the agent's project by now: as if it weren't there.
      yield* service.setControls({
        target: { type: "account", accountId },
        access: "allowed",
        scope: { type: "projects", projectIds: [ProjectId.make("project-other")] },
      });
      const later = (yield* service.snapshot).accounts[0]!.updatedAt;
      expect((yield* service.agentRemove(accountId, later, by).pipe(Effect.flip)).reason).toBe(
        "not-found",
      );
    }),
  );

  it.effect("removes with the person's Undo, and brings it back from the receipt", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const { accountId } = yield* service.save(website());
      const manage = (input: Parameters<typeof manageAccount>[0]) =>
        asAgent(service, manageAccount(input, noCheck));
      const { version } = (yield* manage({ action: "get", accountId })).account!;
      const removed = yield* manage({ action: "remove", accountId, version });
      expect(removed.undo).toMatch(new RegExp(`^${accountId}/`));
      const shown = yield* service.snapshot;
      expect(shown.accounts).toEqual([]);
      // The person's Removed band offers the same Undo.
      expect(shown.removed?.map((entry) => entry.accountId)).toEqual([accountId]);
      yield* manage({ action: "undo", undo: removed.undo! });
      const back = yield* service.snapshot;
      expect(back.accounts.map((account) => account.accountId)).toEqual([accountId]);
      // Brought back at a new version: a write from before the removal is stale.
      expect(back.accounts[0]!.updatedAt).not.toBe(version);
      expect(
        (yield* manage({ action: "remove", accountId, version }).pipe(Effect.flip)).reason,
      ).toBe("conflict");
      expect(back.changes?.map(({ change }) => change)).toEqual(["remove", "restore"]);
    }),
  );

  it.effect("checks every account by looking, a page at a time", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      for (let index = 0; index < 3; index++)
        yield* service.save({ ...website(), name: `Site ${index}` });
      const looked: Array<AccountId> = [];
      const look = (accountId: AccountId) =>
        Effect.sync(() => {
          looked.push(accountId);
          return { state: "signed-in" };
        });
      const first = yield* asAgent(service, manageAccount({ action: "check_all", limit: 2 }, look));
      expect("checked" in first ? first.checked : []).toHaveLength(2);
      expect(first).toMatchObject({ nextCursor: 2 });
      const rest = yield* asAgent(
        service,
        manageAccount({ action: "check_all", limit: 2, cursor: 2 }, look),
      );
      expect("checked" in rest ? rest.checked : []).toHaveLength(1);
      expect(looked).toHaveLength(3);
    }),
  );
});

describe("an agent and browser profiles, stage A", () => {
  it.effect("removes a profile at the version it read, with the user's Undo, and reports it", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const profileId = BrowserProfileId.make("profile-agent");
      yield* service.reportProfiles([{ profileId, name: "Agent work" }]);
      const profiles = (input: Parameters<typeof manageBrowserProfiles>[0]) =>
        asAgent(service, manageBrowserProfiles(input));
      const listed = yield* profiles({ action: "list" });
      const version = ("profiles" in listed ? listed.profiles : []).find(
        (item) => item.profileId === profileId,
      )!.version;
      // A stale version: nothing happens.
      expect(
        (yield* profiles({ action: "remove", profileId, version: "2020-01-01T00:00:00.000Z" }).pipe(
          Effect.flip,
        )).reason,
      ).toBe("conflict");
      const removed = yield* profiles({ action: "remove", profileId, version });
      const operation = "operation" in removed ? removed.operation! : undefined;
      expect(operation).toMatchObject({ kind: "remove", server: "done" });
      // Gone for agents; the user sees it as this chat's, with Undo.
      const after = yield* profiles({ action: "list" });
      expect(
        ("profiles" in after ? after.profiles : []).some((item) => item.profileId === profileId),
      ).toBe(false);
      expect((yield* service.snapshot).changes).toContainEqual(
        expect.objectContaining({ change: "remove", threadId }),
      );
      const status = yield* profiles({ action: "status", operationId: operation!.operationId });
      expect("operation" in status ? status.operation : undefined).toMatchObject({
        operationId: operation!.operationId,
        kind: "remove",
      });
      const undone = yield* profiles({ action: "undo", operationId: operation!.operationId });
      expect(undone).toMatchObject({ operation: { undone: true } });
      const back = yield* profiles({ action: "list" });
      expect(
        ("profiles" in back ? back.profiles : []).some((item) => item.profileId === profileId),
      ).toBe(true);
    }),
  );

  it.effect("transfers sites into another profile, never into one that reaches further", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const lab = BrowserProfileId.make("profile-lab");
      const home = BrowserProfileId.make("profile-home");
      yield* service.reportProfiles([
        { profileId: lab, name: "Lab" },
        { profileId: home, name: "Home" },
      ]);
      yield* service.setControls({
        target: { type: "profile", profileId: lab },
        scope: { type: "projects", projectIds: [projectId] },
      });
      const profiles = (input: Parameters<typeof manageBrowserProfiles>[0]) =>
        asAgent(service, manageBrowserProfiles(input));
      const versionOf = (listed: unknown, id: string) =>
        (listed as { profiles: Array<{ profileId: string; version: string }> }).profiles.find(
          (item) => item.profileId === id,
        )!.version;
      const listed = yield* profiles({ action: "list" });
      const widening = yield* profiles({
        action: "transfer",
        profileId: lab,
        version: versionOf(listed, lab),
        into: home,
        sites: ["example.com"],
      });
      expect(widening).toMatchObject({
        message: "Its sign-ins would reach further there: narrow that profile first.",
      });
      // Selectors are explicit: a transfer names its sites.
      expect(
        (yield* profiles({
          action: "transfer",
          profileId: lab,
          version: versionOf(listed, lab),
          into: home,
        }).pipe(Effect.flip)).reason,
      ).toBe("invalid-input");
      yield* service.setControls({
        target: { type: "profile", profileId: home },
        scope: { type: "projects", projectIds: [projectId] },
      });
      const again = yield* profiles({ action: "list" });
      const moved = yield* profiles({
        action: "transfer",
        mode: "move",
        profileId: lab,
        version: versionOf(again, lab),
        into: home,
        sites: ["example.com"],
      });
      expect(moved).toMatchObject({ operation: { kind: "move" } });
    }),
  );

  it.effect("lists profiles and a profile's sign-ins, and only tightens its controls", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const profileId = BrowserProfileId.make("default");
      yield* service.save({
        ...website(),
        details: { kind: "website", sites: ["example.com"], username: "ada", profileId },
      });
      const profiles = (input: Parameters<typeof manageBrowserProfiles>[0]) =>
        asAgent(service, manageBrowserProfiles(input));
      const listed = yield* profiles({ action: "list" });
      expect(("profiles" in listed ? listed.profiles : []).map((item) => item.profileId)).toContain(
        profileId,
      );
      const sites = yield* profiles({ action: "sites", profileId });
      expect("sites" in sites ? sites.sites : []).toEqual([
        expect.objectContaining({ site: "example.com", username: "ada" }),
      ]);
      const version = ("profiles" in listed ? listed.profiles : []).find(
        (item) => item.profileId === profileId,
      )!.version;
      // A version is needed to write.
      expect(
        (yield* profiles({ action: "controls", profileId, scriptSignIn: false }).pipe(Effect.flip))
          .reason,
      ).toBe("invalid-input");
      yield* profiles({
        action: "controls",
        profileId,
        version,
        access: "ask",
        scriptSignIn: false,
      });
      const record = (yield* service.snapshot).profiles.find(
        (item) => item.profileId === profileId,
      );
      expect(record).toMatchObject({ access: "ask", scriptSignIn: false });
      // regression: a write at the version read before that change went through.
      expect(
        (yield* profiles({ action: "controls", profileId, version, scope: [projectId] }).pipe(
          Effect.flip,
        )).reason,
      ).toBe("conflict");
      expect(
        (yield* service
          .agentControls(
            { target: { type: "profile", profileId }, scriptSignIn: true },
            record!.updatedAt!,
            { threadId, projectId },
          )
          .pipe(Effect.flip)).reason,
      ).toBe("denied");
    }),
  );
});

describe("an agent and the user's browser profiles to import from (AMENDMENTS 58)", () => {
  const laptop = { id: "env-laptop", label: "Ada's laptop" };
  it.effect("lists them a page at a time, 20 unless asked for up to 50", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      // An import reads only its own desktop's browsers: this is the laptop's server (6f).
      yield* service.attachProfileStore(laptopServer);
      yield* service.reportProfiles([], {
        computer: laptop,
        sources: Array.from({ length: 60 }, (_, index) => ({
          browser: "chrome" as const,
          directory: `Profile ${index}`,
          name: `Person ${index}`,
        })),
      });
      const profiles = (input: Parameters<typeof manageBrowserProfiles>[0]) =>
        asAgent(service, manageBrowserProfiles(input));
      const first = yield* profiles({ action: "sources" });
      expect("sources" in first ? first.sources : []).toHaveLength(20);
      expect(first).toMatchObject({ nextCursor: 20 });
      expect("sources" in first ? first.sources?.[0] : undefined).toEqual({
        sourceId: "env-laptop/chrome/Profile 0",
        name: "Chrome · Person 0",
        computer: "Ada's laptop",
      });
      const most = yield* profiles({ action: "sources", cursor: 20, limit: 50 });
      expect("sources" in most ? most.sources : []).toHaveLength(40);
      expect("nextCursor" in most ? most.nextCursor : undefined).toBeUndefined();
      // More than 50 at once isn't asked for.
      const parameters = Schema.decodeUnknownExit(
        ScientAccountsToolkit.tools.scient_browser_profiles.parametersSchema,
      );
      expect(Exit.isFailure(parameters({ action: "sources", limit: 51 }))).toBe(true);
      expect(Exit.isSuccess(parameters({ action: "sources", limit: 50 }))).toBe(true);
    }),
  );

  it.effect("imports one into a new profile by default, and names the profile it made", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      // An import reads only its own desktop's browsers: this is the laptop's server (6f).
      yield* service.attachProfileStore(laptopServer);
      yield* service.reportProfiles([], {
        computer: laptop,
        sources: [{ browser: "edge", directory: "Default", name: "Work" }],
      });
      const profiles = (input: Parameters<typeof manageBrowserProfiles>[0]) =>
        asAgent(service, manageBrowserProfiles(input));
      const started = yield* profiles({
        action: "import",
        sourceId: "env-laptop/edge/Default",
        cookies: true,
      });
      expect(started).toMatchObject({
        operation: { kind: "refresh", desktop: "pending" },
        message: expect.stringContaining("Started on Ada's laptop"),
      });
      const made = "profileId" in started ? started.profileId : undefined;
      expect(made).toMatch(/^profile-/);
      const listed = yield* profiles({ action: "list" });
      expect("profiles" in listed ? listed.profiles : []).toContainEqual(
        expect.objectContaining({ profileId: made, name: "Edge · Work" }),
      );
      // Linked once the import has succeeded (round 6d).
      const sources = yield* profiles({ action: "sources" });
      expect("sources" in sources ? sources.sources?.[0]?.linkedTo : undefined).toBeUndefined();
      yield* service.profileStoreDone({
        operationId: "operation" in started ? started.operation.operationId : "",
        phase: "do",
        outcome: { state: "done", copied: 1 },
      });
      const linked = yield* profiles({ action: "sources" });
      expect("sources" in linked ? linked.sources?.[0]?.linkedTo : undefined).toBe(made);
    }),
  );
});

describe("an agent's retry is the same operation (round 6c, finding 6)", () => {
  it.effect(
    "returns the first receipt for the same call, and makes one profile from a source",
    () =>
      Effect.gen(function* () {
        const { service } = yield* makeHarness();
        // An import reads only its own desktop's browsers: this is the laptop's server (6f).
        yield* service.attachProfileStore(laptopServer);
        const profileId = BrowserProfileId.make("profile-retry");
        yield* service.reportProfiles([{ profileId, name: "Retry" }], {
          computer: { id: "env-laptop", label: "Ada's laptop" },
          sources: [{ browser: "chrome", directory: "Profile 1", name: "Work" }],
        });
        const profiles = (input: Parameters<typeof manageBrowserProfiles>[0]) =>
          asAgent(service, manageBrowserProfiles(input));
        const listed = yield* profiles({ action: "list" });
        const version = ("profiles" in listed ? listed.profiles : []).find(
          (item) => item.profileId === profileId,
        )!.version;
        const first = yield* profiles({
          action: "sign_out",
          profileId,
          version,
          site: "a.example",
        });
        const again = yield* profiles({
          action: "sign_out",
          profileId,
          version,
          site: "a.example",
        });
        expect("operation" in again ? again.operation?.operationId : undefined).toBe(
          "operation" in first ? first.operation?.operationId : "none",
        );
        const imports = [
          yield* profiles({
            action: "import",
            sourceId: "env-laptop/chrome/Profile 1",
            cookies: true,
          }),
          yield* profiles({
            action: "import",
            sourceId: "env-laptop/chrome/Profile 1",
            cookies: true,
          }),
        ];
        expect(
          new Set(imports.map((reply) => ("profileId" in reply ? reply.profileId : ""))),
        ).toHaveProperty("size", 1);
        expect(
          ((yield* service.snapshot).profileOperations ?? []).filter(
            ({ kind }) => kind === "sign-out" || kind === "refresh",
          ),
        ).toHaveLength(2);
      }),
  );
});

describe("an agent is told when only part of it was done (round 6c, finding 9)", () => {
  it.effect("names the sites that didn't come over in its receipt", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const from = BrowserProfileId.make("profile-from");
      const into = BrowserProfileId.make("profile-into");
      yield* service.reportProfiles([
        { profileId: from, name: "From" },
        { profileId: into, name: "Into" },
      ]);
      yield* service.attachProfileStore({
        desktop: false,
        generations: () => Effect.void,
        closeProfile: () => Effect.void,
        signOut: () => Effect.succeed({ cookies: [] }),
        restore: () => Effect.succeed({ restored: 0, refused: 0 }),
        copy: (_from, _into, sites, keep) =>
          keep({ before: [], copied: [] }).pipe(
            Effect.as({ copied: 0, uncovered: ["bank.example"], sites: sites ?? [] }),
          ),
        restoreInto: () => Effect.succeed({ restored: 0, refused: 0 }),
        purge: () => Effect.void,
      });
      const profiles = (input: Parameters<typeof manageBrowserProfiles>[0]) =>
        asAgent(service, manageBrowserProfiles(input));
      const listed = yield* profiles({ action: "list" });
      const version = ("profiles" in listed ? listed.profiles : []).find(
        (item) => item.profileId === from,
      )!.version;
      const copied = yield* profiles({
        action: "transfer",
        profileId: from,
        into,
        version,
        sites: ["bank.example"],
      });
      expect("operation" in copied ? copied.operation : undefined).toMatchObject({
        notCopied: ["bank.example"],
      });
    }),
  );
});

describe("an agent is told done only once it is (round 6d, row 9)", () => {
  it.effect("says a sign-out the desktop hasn't done yet is started, then done", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const profileId = BrowserProfileId.make("profile-pending");
      yield* service.reportProfiles([{ profileId, name: "Pending" }]);
      yield* service.attachProfileStore({
        desktop: true,
        generations: () => Effect.void,
        closeProfile: () => Effect.void,
        signOut: (_profileId, _site, keep) =>
          (keep ? keep([]) : Effect.void).pipe(Effect.as({ cookies: [] })),
        restore: () => Effect.succeed({ restored: 0, refused: 0 }),
        copy: (_from, _into, sites, keep) =>
          keep({ before: [], copied: [] }).pipe(
            Effect.as({ copied: 0, uncovered: [], sites: sites ?? [] }),
          ),
        restoreInto: () => Effect.succeed({ restored: 0, refused: 0 }),
        purge: () => Effect.void,
      });
      const profiles = (input: Parameters<typeof manageBrowserProfiles>[0]) =>
        asAgent(service, manageBrowserProfiles(input));
      const listed = yield* profiles({ action: "list" });
      const version = ("profiles" in listed ? listed.profiles : []).find(
        (item) => item.profileId === profileId,
      )!.version;
      const started = yield* profiles({
        action: "sign_out",
        profileId,
        version,
        site: "a.example",
      });
      expect(started).toMatchObject({ message: expect.stringMatching(/^Started; not done yet/) });
      const operationId = "operation" in started ? started.operation!.operationId : "";
      yield* service.profileStoreDone({
        operationId,
        phase: "do",
        outcome: { state: "done", saved: 1 },
      });
      expect(yield* profiles({ action: "status", operationId })).toMatchObject({
        message: "Done. The user sees it with Undo for an hour.",
      });
    }),
  );
});

describe("an import's reply names its cause or its counts (round 6d, Step 8)", () => {
  it.effect("says why it failed with the one thing to do, and how many passwords it saved", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      // An import reads only its own desktop's browsers: this is the laptop's server (6f).
      yield* service.attachProfileStore(laptopServer);
      yield* service.reportProfiles([], {
        computer: { id: "env-laptop", label: "Ada's laptop" },
        sources: [{ browser: "chrome", directory: "Default", name: "Work" }],
      });
      const profiles = (input: Parameters<typeof manageBrowserProfiles>[0]) =>
        asAgent(service, manageBrowserProfiles(input));
      const importOnce = (passwords: boolean) =>
        profiles({
          action: "import",
          sourceId: "env-laptop/chrome/Default",
          ...(passwords ? { passwords: true } : { cookies: true }),
        });
      const idOf = (reply: unknown) =>
        (reply as { operation: { operationId: string } }).operation.operationId;
      const locked = idOf(yield* importOnce(false));
      yield* service.profileStoreDone({
        operationId: locked,
        phase: "do",
        outcome: { state: "failed", cause: "browserRunning" },
      });
      // regression: "Partly done: a part failed", with nothing to do about it.
      expect(yield* profiles({ action: "status", operationId: locked })).toMatchObject({
        message: "Didn't finish: Quit the browser first so its cookie database can be read.",
      });
      const passwordsOnly = idOf(yield* importOnce(true));
      yield* service.profileStoreDone({
        operationId: passwordsOnly,
        phase: "do",
        outcome: { state: "done", copied: 0, passwords: 4 },
      });
      expect(yield* profiles({ action: "status", operationId: passwordsOnly })).toMatchObject({
        message: expect.stringContaining("4 passwords"),
      });
    }),
  );
});

describe("an agent hears what a sign-out left, on every desktop (round 6e)", () => {
  it.effect("says partly done, naming each desktop's leftovers, never done", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      const lab = BrowserProfileId.make("profile-lab");
      const laptop = { id: "env-laptop", label: "Ada's laptop" };
      yield* service.reportProfiles([{ profileId: lab, name: "Lab" }]);
      yield* service.attachProfileStore({
        desktop: true,
        computer: { id: "env-desk", label: "Lab desk" },
        generations: () => Effect.void,
        closeProfile: () => Effect.void,
        signOut: (_p, _s, keep) => (keep ? keep([]) : Effect.void).pipe(Effect.as({ cookies: [] })),
        restore: () => Effect.succeed({ restored: 0, refused: 0 }),
        copy: (_f, _i, sites, keep) =>
          keep({ before: [], copied: [] }).pipe(
            Effect.as({ copied: 0, uncovered: [], sites: sites ?? [] }),
          ),
        restoreInto: () => Effect.succeed({ restored: 0, refused: 0 }),
        purge: () => Effect.void,
      });
      yield* service.reportProfiles([], { computer: laptop, sources: [] });
      const profiles = (input: Parameters<typeof manageBrowserProfiles>[0]) =>
        asAgent(service, manageBrowserProfiles(input));
      const listed = yield* profiles({ action: "list" });
      const version = ("profiles" in listed ? listed.profiles : []).find(
        (item) => item.profileId === lab,
      )!.version;
      const started = yield* profiles({
        action: "sign_out",
        profileId: lab,
        version,
        site: "example.com",
      });
      const operationId = (started as { operation: { operationId: string } }).operation.operationId;
      yield* service.profileStoreDone({
        operationId,
        phase: "do",
        outcome: { state: "done", saved: 2, leftBehind: 1 },
      });
      // An agent's sign-out has no part on the laptop (round 6f): only this computer's.
      // regression: "Done" with a cookie still signed in here.
      expect(yield* profiles({ action: "status", operationId })).toMatchObject({
        message:
          "Partly done: 1 cookies couldn't be signed out on this computer. The user sees it with Undo for an hour.",
      });
    }),
  );
});

describe("a request is its own, past its hour or its Undo (round 6d, verdict 4)", () => {
  it.effect("never undoes an import, and a retry at once is the same request (round 6m)", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      // An import reads only its own desktop's browsers: this is the laptop's server (6f).
      yield* service.attachProfileStore(laptopServer);
      const profileId = BrowserProfileId.make("profile-again");
      yield* service.reportProfiles([{ profileId, name: "Again" }], {
        computer: { id: "env-laptop", label: "Ada's laptop" },
        sources: [{ browser: "chrome", directory: "Profile 1", name: "Work" }],
      });
      const profiles = (input: Parameters<typeof manageBrowserProfiles>[0]) =>
        asAgent(service, manageBrowserProfiles(input));
      const importing = {
        action: "import" as const,
        sourceId: "env-laptop/chrome/Profile 1",
        cookies: true,
      };
      const first = yield* profiles(importing);
      const firstProfile = "profileId" in first ? first.profileId : undefined;
      const firstId = "operation" in first ? first.operation!.operationId : "";
      yield* service.profileStoreDone({
        operationId: firstId,
        phase: "do",
        outcome: { state: "done", copied: 1 },
      });
      // It copied the person's own browser sign-ins: no Undo, its Activity line stays.
      const undone = yield* profiles({ action: "undo", operationId: firstId }).pipe(Effect.flip);
      expect(undone.message).toBe("An import or refresh can't be undone.");
      expect(firstProfile).toBeDefined();
      // A retry of it, at once, is still the same request.
      const retry = yield* profiles(importing);
      expect("operation" in retry ? retry.operation!.operationId : "").toBe(firstId);
    }),
  );
  it.effect(
    "never gives a new request an id used before, once its receipt is gone (round 6e)",
    () =>
      Effect.gen(function* () {
        const { service } = yield* makeHarness();
        const lab = BrowserProfileId.make("profile-lab");
        yield* service.reportProfiles([{ profileId: lab, name: "Lab" }]);
        const profiles = (input: Parameters<typeof manageBrowserProfiles>[0]) =>
          asAgent(service, manageBrowserProfiles(input));
        const listed = yield* profiles({ action: "list" });
        const version = ("profiles" in listed ? listed.profiles : []).find(
          (item) => item.profileId === lab,
        )!.version;
        const call = { action: "sign_out" as const, profileId: lab, version, site: "a.example" };
        const first = yield* profiles(call);
        const firstId = (first as { operation: { operationId: string } }).operation.operationId;
        // Past its hour, then pushed out by 200 newer receipts.
        yield* TestClock.adjust("2 hours");
        for (let index = 0; index < 200; index++)
          yield* service.operateProfile(
            {
              operationId: `op-${index}`,
              kind: "sign-out",
              profileId: lab,
              site: `site${index}.example`,
            },
            undefined,
            [],
          );
        const again = yield* profiles(call);
        // regression: the same call was given the evicted receipt's id again.
        expect((again as { operation: { operationId: string } }).operation.operationId).not.toBe(
          firstId,
        );
      }),
  );
});

describe("two identical imports at once are one (round 6f)", () => {
  it.effect("matches the call under the admission permit: one receipt, one profile", () =>
    Effect.gen(function* () {
      const { service } = yield* makeHarness();
      yield* service.attachProfileStore(laptopServer);
      yield* service.reportProfiles([], {
        computer: { id: "env-laptop", label: "Ada's laptop" },
        sources: [{ browser: "chrome", directory: "Profile 1", name: "Work" }],
      });
      const importing = asAgent(
        service,
        manageBrowserProfiles({
          action: "import",
          sourceId: "env-laptop/chrome/Profile 1",
          cookies: true,
        }),
      );
      const [first, second] = yield* Effect.all([importing, importing], { concurrency: 2 });
      const idOf = (reply: unknown) =>
        (reply as { operation: { operationId: string } }).operation.operationId;
      // regression: both looked before either was admitted, and two profiles were made.
      expect(idOf(second)).toBe(idOf(first));
      const made = (yield* service.snapshot).profiles.filter(
        ({ name }) => name === "Chrome · Work",
      );
      expect(made).toHaveLength(1);
    }),
  );
});

it("promises no Undo for an import or refresh, in the tool or a stopped import's reply (6n)", () => {
  const description = ScientAccountsToolkit.tools.scient_browser_profiles.description ?? "";
  // regression: "Each is the user's own action, with their Undo for an hour", import included.
  expect(description).toContain("all but an import or refresh can be undone for an hour");
  expect(PROFILE_IMPORT_CAUSE_COPY.stopped).not.toMatch(/put back|undo|roll/i);
});
