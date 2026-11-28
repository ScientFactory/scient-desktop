import { EnvironmentId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  order: [] as string[],
  blocked: undefined as string | undefined,
  copied: 3,
}));
vi.mock("~/components/preview/previewBridge", () => ({ previewBridge: {} }));
vi.mock("~/components/settings/IntegrationsSettings", () => ({
  importBrowserCookiesIntoTarget: async (
    _bridge: unknown,
    source: { id: string },
    _environmentId: string,
    input: { sourceProfileDirectory: string; targetGeneration?: number },
  ) => {
    state.order.push(
      `import:${source.id}:${input.sourceProfileDirectory}${input.targetGeneration === undefined ? "" : `:g${input.targetGeneration}`}`,
    );
    return state.blocked
      ? { kind: "blocked", reason: state.blocked }
      : { kind: "imported", importedSites: state.copied };
  },
}));
vi.mock("./accountsView", () => ({
  sitesToKeep: () => [],
  loadSourceProfiles: async () => [
    // Two Chrome profiles of the same name: only the linked folder is read.
    {
      id: "chrome",
      name: "Chrome",
      profiles: [
        { name: "Person", directory: "Profile 2", passwordCount: 0 },
        { name: "Person", directory: "Profile 1", passwordCount: 2 },
        // Its passwords can't be counted, so can't be read.
        { name: "Other", directory: "Profile 3" },
      ],
    },
  ],
}));
vi.mock("./importedSessions", () => ({
  recordImportedSessions: async () => void state.order.push("record"),
}));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  runAtomCommand: async () => {
    state.order.push("passwords");
    return { _tag: "Success", value: { created: 2, updated: 1, skipped: 0 } };
  },
}));
vi.mock("./accountsState", () => ({ accountsState: { importPasswords: "import" } }));
vi.mock("./mainFill", () => ({ sendMainRefresh: async () => void state.order.push("send") }));
vi.stubGlobal("window", {
  desktopBridge: {
    accounts: {
      importBrowserPasswords: async () => {
        state.order.push("passwords");
        return { result: { created: 2, updated: 1, skipped: 0 }, skipped: 0 };
      },
    },
  },
});

const { refreshFromLink } = await import("./profileRefresh");

it("refreshes from the linked folder with the person's import, keeping the cookies first", async () => {
  const operation = {
    operationId: "op-refresh",
    kind: "refresh" as const,
    profileId: "profile-lab",
    at: "2026-11-26T00:00:00.000Z",
    until: "2026-11-26T01:00:00.000Z",
    cookies: true,
    passwords: true,
  };
  const snapshot = {
    accounts: [],
    profiles: [
      {
        profileId: "profile-lab",
        access: "allowed",
        scope: { type: "all-projects" },
        scriptSignIn: true,
        source: {
          browser: "chrome",
          profileName: "Person",
          directory: "Profile 1",
          importedAt: "",
        },
      },
    ],
  };
  const outcome = await refreshFromLink({
    environmentId: EnvironmentId.make("env-local"),
    snapshot: snapshot as never,
    operation: operation as never,
  });
  expect(outcome).toEqual({ state: "done", copied: 3, passwords: 3 });
  // No copy is kept for an Undo: a refresh has none (round 6m).
  expect(state.order).toEqual(["import:chrome:Profile 1", "record", "passwords"]);
  // Not linked: nothing is read or changed.
  state.order = [];
  expect(
    await refreshFromLink({
      environmentId: EnvironmentId.make("env-local"),
      snapshot: { accounts: [], profiles: [] } as never,
      operation: operation as never,
    }),
  ).toEqual({ state: "failed", cause: "notLinked" });
  expect(state.order).toEqual([]);
});

it("stops before its passwords when its computer's Accounts no longer stands behind it", async () => {
  state.order = [];
  const outcome = await refreshFromLink({
    environmentId: EnvironmentId.make("env-local"),
    snapshot: {
      accounts: [],
      profiles: [
        {
          profileId: "profile-lab",
          access: "allowed",
          scope: { type: "all-projects" },
          scriptSignIn: true,
          source: {
            browser: "chrome",
            profileName: "Person",
            directory: "Profile 1",
            importedAt: "",
          },
        },
      ],
    } as never,
    operation: {
      operationId: "op-revoked",
      kind: "refresh",
      profileId: "profile-lab",
      at: "2026-11-26T00:00:00.000Z",
      until: "2026-11-26T01:00:00.000Z",
      cookies: true,
      passwords: true,
    } as never,
    // Removed while Chrome's prompt was open.
    stillStands: async () => false,
  });
  expect(outcome).toEqual({ state: "failed", cause: "stopped" });
  // It wrote only while it stood, at its write; nothing is put back, no password is read.
  expect(state.order).toEqual(["import:chrome:Profile 1"]);
});

it("imports from the operation's own source, which links the profile only once it succeeds", async () => {
  state.order = [];
  const outcome = await refreshFromLink({
    environmentId: EnvironmentId.make("env-local"),
    // Not linked yet (round 6d): its computer's Accounts links it once this has succeeded.
    snapshot: { accounts: [], profiles: [] } as never,
    operation: {
      operationId: "op-import",
      kind: "refresh",
      profileId: "profile-made",
      at: "2026-11-26T00:00:00.000Z",
      until: "2026-11-26T01:00:00.000Z",
      cookies: true,
      link: {
        browser: "chrome",
        profileName: "Person",
        directory: "Profile 2",
        importedAt: "2026-11-26T00:00:00.000Z",
      },
    } as never,
  });
  expect(outcome).toEqual({ state: "done", copied: 3 });
  expect(state.order).toEqual(["import:chrome:Profile 2", "record"]);
});

it("keeps a failure's cause, and never calls a password import done without reading them", async () => {
  const run = (operation: object) =>
    refreshFromLink({
      environmentId: EnvironmentId.make("env-local"),
      snapshot: { accounts: [], profiles: [] } as never,
      operation: {
        operationId: "op-cause",
        kind: "refresh",
        profileId: "profile-lab",
        at: "2026-11-26T00:00:00.000Z",
        until: "2026-11-26T01:00:00.000Z",
        link: {
          browser: "chrome",
          profileName: "Person",
          directory: "Profile 1",
          importedAt: "",
        },
        ...operation,
      } as never,
    });
  // regression: Chrome running came back as a bare failure.
  state.blocked = "browserRunning";
  expect(await run({ cookies: true })).toEqual({ state: "failed", cause: "browserRunning" });
  state.blocked = undefined;
  // A password-only import says how many it saved.
  expect(await run({ passwords: true })).toEqual({ state: "done", copied: 0, passwords: 3 });
  // regression: a browser whose passwords can't be read reported done.
  expect(
    await run({
      passwords: true,
      link: { browser: "chrome", profileName: "Other", directory: "Profile 3", importedAt: "" },
    }),
  ).toEqual({ state: "failed", cause: "passwordsUnreadable" });
});

it("imports into the generation it was decided in (round 6e)", async () => {
  state.order = [];
  await refreshFromLink({
    environmentId: EnvironmentId.make("env-local"),
    snapshot: { accounts: [], profiles: [] } as never,
    operation: {
      operationId: "op-pinned",
      kind: "refresh",
      profileId: "profile-lab",
      generation: 2,
      at: "2026-11-26T00:00:00.000Z",
      until: "2026-11-26T01:00:00.000Z",
      cookies: true,
      link: { browser: "chrome", profileName: "Person", directory: "Profile 1", importedAt: "" },
    } as never,
  });
  // regression: the import went into whatever generation the profile was in by then.
  expect(state.order).toContain("import:chrome:Profile 1:g2");
});

it("asks again before it reads the browser's passwords (round 6f)", async () => {
  state.order = [];
  let asked = 0;
  const late = await refreshFromLink({
    environmentId: EnvironmentId.make("env-local"),
    snapshot: { accounts: [], profiles: [] } as never,
    operation: {
      operationId: "op-late",
      kind: "refresh",
      profileId: "profile-lab",
      at: "2026-11-26T00:00:00.000Z",
      until: "2026-11-26T01:00:00.000Z",
      cookies: true,
      passwords: true,
      link: { browser: "chrome", profileName: "Person", directory: "Profile 1", importedAt: "" },
    } as never,
    // It stood after the cookies came; revoked before the passwords were read.
    stillStands: async () => ++asked === 1,
  });
  // regression: the passwords were read and sent after the agent's access was gone.
  expect(late).toMatchObject({ state: "failed", cause: "stopped" });
  expect(state.order).not.toContain("passwords");
});

it("sends a refresh of Main to other computers only once it still stands (round 6j)", async () => {
  const refreshMain = (stillStands: boolean) =>
    refreshFromLink({
      environmentId: EnvironmentId.make("env-local"),
      snapshot: { accounts: [], profiles: [] } as never,
      operation: {
        operationId: "op-main",
        kind: "refresh",
        profileId: "default",
        at: "2026-11-26T00:00:00.000Z",
        until: "2026-11-26T01:00:00.000Z",
        cookies: true,
        link: { browser: "chrome", profileName: "Person", directory: "Profile 1", importedAt: "" },
      } as never,
      stillStands: async () => stillStands,
    });
  state.order = [];
  await refreshMain(false);
  // regression: what the refresh brought could reach other computers before its check.
  expect(state.order).not.toContain("send");
  state.order = [];
  await refreshMain(true);
  expect(state.order.indexOf("send")).toBeGreaterThan(
    state.order.indexOf("import:chrome:Profile 1"),
  );
  // Main's fill refused: nothing of Main is sent (round 6k).
  state.order = [];
  state.blocked = "readFailed";
  try {
    await refreshMain(true);
  } finally {
    state.blocked = undefined;
  }
  // regression: a blocked import still sent Main's whole jar to other computers.
  expect(state.order).not.toContain("send");
  // Every site Main's own, nothing copied: nothing is sent either (round 6l).
  state.order = [];
  state.copied = 0;
  try {
    await refreshMain(true);
  } finally {
    state.copied = 3;
  }
  // regression: an all-conflict fill counted as imported and sent Main's whole jar.
  expect(state.order).not.toContain("send");
});
