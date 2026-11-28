import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import {
  AccountId,
  EnvironmentId,
  ThreadId,
  defaultAccountControls,
  type AccountsSnapshot,
  type DesktopAccountsBridge,
  type DesktopSignInPage,
} from "@t3tools/contracts";
import { act, render } from "../../../test/render";
import { BrowserAccountControls } from "./BrowserAccountControls";

const state = vi.hoisted(() => ({
  toasts: [] as Array<{ title?: unknown; actionProps?: { onClick?: () => unknown } }>,
  snapshot: null as AccountsSnapshot | null,
  error: null as string | null,
  request: null as (() => Promise<{ ok: true; value: { username: string } }>) | null,
}));
vi.mock("~/components/ui/toast", async (original) => ({
  ...(await original<typeof import("~/components/ui/toast")>()),
  toastManager: {
    add: (toast: (typeof state.toasts)[number]) => {
      state.toasts.push(toast);
      return "synthetic-toast";
    },
    close: () => undefined,
  },
}));
vi.mock("./useAccounts", () => ({
  useAccounts: () => ({
    data: state.snapshot,
    error: state.error,
    refresh: () => undefined,
    canWrite: true,
  }),
  useAccountCommand: () => state.request,
}));

function setup() {
  state.snapshot = null;
  state.error = null;
  state.request = null;
}

it("withholds autofill from an older bridge and drops values after the tab navigates", async () => {
  setup();
  const entered = Promise.withResolvers<void>();
  const response = Promise.withResolvers<{ ok: true; value: { username: string } }>();
  state.request = () => {
    entered.resolve();
    return response.promise;
  };
  state.snapshot = {
    agentAccess: true,
    accounts: [
      {
        accountId: AccountId.make("acc_synthetic01"),
        name: "Synthetic",
        details: { kind: "website", sites: ["example.com"] },
        secrets: { password: { source: { type: "scient" } } },
        controls: defaultAccountControls("website"),
        status: "ready",
        createdAt: "2026-10-26T00:00:00.000Z",
        updatedAt: "2026-10-26T00:00:00.000Z",
      },
    ],
    profiles: [],
    stores: {
      scient: { protection: "keychain" },
      keychain: { available: false, platform: "linux" },
      onePassword: { state: "not-connected" },
    },
    approvals: [],
    recentActivity: [],
    customModelKeys: [],
  };
  let filled = false;
  const bridge: DesktopAccountsBridge = {
    sourceProfiles: async () => [],
    signedInSites: async () => [],
    fill: async () => {
      filled = true;
      return true;
    },
    onSignInCaptured: () => () => undefined,
  };
  const previous = Object.getOwnPropertyDescriptor(window, "desktopBridge");
  using _bridge = {
    [Symbol.dispose]() {
      if (previous) Object.defineProperty(window, "desktopBridge", previous);
      else Reflect.deleteProperty(window, "desktopBridge");
    },
  };
  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    value: { accounts: bridge },
  });
  const environmentId = EnvironmentId.make("synthetic");
  await using screen = await render(
    <BrowserAccountControls
      environmentId={environmentId}
      threadRef={{ environmentId, threadId: ThreadId.make("synthetic-thread") }}
      tabId="synthetic-tab"
      profileId="default"
      url="https://example.com/login"
    />,
  );
  await expect
    .element(page.getByRole("button", { name: "Saved sign-ins for example.com" }))
    .not.toBeInTheDocument();
  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    value: { accounts: { ...bridge, originBoundFill: true } },
  });
  await screen.rerender(
    <BrowserAccountControls
      key="current-bridge"
      environmentId={environmentId}
      threadRef={{ environmentId, threadId: ThreadId.make("synthetic-thread") }}
      tabId="synthetic-tab"
      profileId="default"
      url="https://example.com/login"
    />,
  );
  await page.getByRole("button", { name: "Saved sign-ins for example.com" }).click();
  await page.getByRole("button", { name: "Fill No username" }).click();
  await entered.promise;
  await screen.rerender(
    <BrowserAccountControls
      environmentId={environmentId}
      threadRef={{ environmentId, threadId: ThreadId.make("synthetic-thread") }}
      tabId="synthetic-tab"
      profileId="default"
      url="https://other.example.org"
    />,
  );
  await act(async () => {
    response.resolve({ ok: true, value: { username: "synthetic" } });
    await response.promise;
  });
  expect(filled).toBe(false);
});

it("offers to save a typed sign-in, except on Scient's own sign-in tab or with no username", async () => {
  setup();
  state.request = async () => ({ ok: true, value: { result: "new" } }) as never;
  const listeners = new Set<
    (capture: Parameters<Parameters<DesktopAccountsBridge["onSignInCaptured"]>[0]>[0]) => void
  >();
  const bridge: DesktopAccountsBridge = {
    sourceProfiles: async () => [],
    signedInSites: async () => [],
    fill: async () => false,
    onSignInCaptured: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const previous = Object.getOwnPropertyDescriptor(window, "desktopBridge");
  using _bridge = {
    [Symbol.dispose]() {
      if (previous) Object.defineProperty(window, "desktopBridge", previous);
      else Reflect.deleteProperty(window, "desktopBridge");
    },
  };
  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    value: { accounts: bridge },
  });
  const snapshot = (attempts: AccountsSnapshot["attempts"]): AccountsSnapshot => ({
    agentAccess: true,
    accounts: [],
    profiles: [],
    stores: {
      scient: { protection: "keychain" },
      keychain: { available: false, platform: "linux" },
      onePassword: { state: "not-connected" },
    },
    approvals: [],
    recentActivity: [],
    customModelKeys: [],
    accountsProtocol: 1,
    attempts,
  });
  const environmentId = EnvironmentId.make("synthetic");
  const controls = (key: string) => (
    <BrowserAccountControls
      key={key}
      environmentId={environmentId}
      threadRef={{ environmentId, threadId: ThreadId.make("synthetic-thread") }}
      tabId="synthetic-tab"
      previewTabId="preview-tab"
      profileId="default"
      url="https://example.com/login"
    />
  );
  const capture = (username = "synthetic") =>
    act(async () => {
      for (const listener of listeners)
        listener({
          tabId: "synthetic-tab",
          profileId: "default",
          url: "https://example.com",
          path: "/login",
          step: "password",
          username,
          password: "synthetic-password",
          usernameFrom: "form",
        });
    });
  state.snapshot = snapshot([
    {
      attemptId: "attempt-1",
      threadId: ThreadId.make("synthetic-thread"),
      tabId: "preview-tab",
      accountId: AccountId.make("acc_synthetic01"),
      state: "person",
    },
  ]);
  await using screen = await render(controls("attempt"));
  await capture();
  await expect.element(page.getByText("Save sign-in?").first()).not.toBeInTheDocument();
  state.snapshot = snapshot([]);
  await screen.rerender(controls("no-attempt"));
  // A code typed on its own step has no username: not a sign-in to save.
  await capture("");
  await expect.element(page.getByText("Save sign-in?").first()).not.toBeInTheDocument();
  await capture();
  await expect.element(page.getByText("Save sign-in?").first()).toBeInTheDocument();
  await expect.element(page.getByText("example.com · synthetic")).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Don't ask for this site" })).toBeVisible();
});

it("shows the key while Accounts loads, and Retry when it couldn't", async () => {
  setup();
  const bridge = Object.getOwnPropertyDescriptor(window, "desktopBridge");
  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    value: { accounts: { onSignInCaptured: () => () => undefined } },
  });
  try {
    const environmentId = EnvironmentId.make("synthetic");
    const controls = (key: string) => (
      <BrowserAccountControls
        key={key}
        environmentId={environmentId}
        threadRef={{ environmentId, threadId: ThreadId.make("synthetic-thread") }}
        tabId="synthetic-tab"
        profileId="default"
        url="https://example.com/login"
      />
    );
    await using screen = await render(controls("loading"));
    await expect
      .element(page.getByRole("button", { name: "Loading saved sign-ins" }))
      .toBeDisabled();
    state.error = "Synthetic failure";
    await screen.rerender(controls("failed"));
    await expect
      .element(page.getByRole("button", { name: "Couldn't load saved sign-ins. Retry" }))
      .toBeEnabled();
  } finally {
    if (bridge) Object.defineProperty(window, "desktopBridge", bridge);
    else Reflect.deleteProperty(window, "desktopBridge");
  }
});

it("fills only the document it read values for, after a same-address reload too", async () => {
  setup();
  const response = Promise.withResolvers<{ ok: true; value: { username: string } }>();
  const entered = Promise.withResolvers<void>();
  state.request = () => {
    entered.resolve();
    return response.promise;
  };
  state.snapshot = {
    agentAccess: true,
    accounts: [
      {
        accountId: AccountId.make("acc_synthetic01"),
        name: "Synthetic",
        details: { kind: "website", sites: ["example.com"] },
        secrets: { password: { source: { type: "scient" } } },
        controls: defaultAccountControls("website"),
        status: "ready",
        createdAt: "2026-10-26T00:00:00.000Z",
        updatedAt: "2026-10-26T00:00:00.000Z",
      },
    ],
    profiles: [],
    stores: {
      scient: { protection: "keychain" },
      keychain: { available: false, platform: "linux" },
      onePassword: { state: "not-connected" },
    },
    approvals: [],
    recentActivity: [],
    customModelKeys: [],
  };
  // The page reloads at the same address while the values are read: a new document.
  let documentId = "document-1";
  const fills: Array<string | undefined> = [];
  const bridge: DesktopAccountsBridge = {
    sourceProfiles: async () => [],
    signedInSites: async () => [],
    originBoundFill: true,
    loginForm: async () => ({
      tabId: "synthetic-tab",
      url: "https://example.com",
      documentId,
      boxes: [],
      userEdited: false,
      hasPassword: true,
      hasValues: false,
      profileId: "default",
    }),
    fill: async (input) => {
      fills.push(input.documentId);
      return true;
    },
    onSignInCaptured: () => () => undefined,
  };
  const previous = Object.getOwnPropertyDescriptor(window, "desktopBridge");
  using _bridge = {
    [Symbol.dispose]() {
      if (previous) Object.defineProperty(window, "desktopBridge", previous);
      else Reflect.deleteProperty(window, "desktopBridge");
    },
  };
  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    value: { accounts: bridge },
  });
  const environmentId = EnvironmentId.make("synthetic");
  await using _screen = await render(
    <BrowserAccountControls
      environmentId={environmentId}
      threadRef={{ environmentId, threadId: ThreadId.make("synthetic-thread") }}
      tabId="synthetic-tab"
      profileId="default"
      url="https://example.com/login"
    />,
  );
  await page.getByRole("button", { name: "Saved sign-ins for example.com" }).click();
  await page.getByRole("button", { name: "Fill No username" }).click();
  await entered.promise;
  documentId = "document-2";
  await act(async () => {
    response.resolve({ ok: true, value: { username: "synthetic" } });
    await response.promise;
  });
  expect(fills).toEqual([]);
  // The same Fill on a page that stays put fills, naming its document to the page.
  const again = Promise.withResolvers<{ ok: true; value: { username: string } }>();
  state.request = () => again.promise;
  // The key's popover stays open after a fill.
  await page.getByRole("button", { name: "Fill No username" }).click();
  await act(async () => {
    again.resolve({ ok: true, value: { username: "synthetic" } });
    await again.promise;
  });
  await vi.waitFor(() => expect(fills).toEqual(["document-2"]));
});

it("answers each capture with its own choice of tenant", async () => {
  setup();
  const row = (id: string, tenant: string) => ({
    accountId: AccountId.make(id),
    name: "Synthetic",
    details: {
      kind: "website" as const,
      sites: ["https://example.com"],
      username: "synthetic",
      loginUrl: `https://example.com/login/${tenant}`,
    },
    secrets: { password: { source: { type: "scient" as const } } },
    controls: defaultAccountControls("website"),
    status: "ready" as const,
    createdAt: "2026-10-26T00:00:00.000Z",
    updatedAt: "2026-10-26T00:00:00.000Z",
  });
  const acme = row("acc_synthetic_acme", "acme");
  const other = row("acc_synthetic_other", "other");
  const saved: string[] = [];
  state.request = (async (input: { path?: string; accountId?: string; secrets?: unknown }) => {
    if (input.secrets !== undefined) {
      saved.push(input.accountId ?? "new");
      return { ok: true, value: {} };
    }
    if (input.path === undefined) return { ok: true, value: {} };
    return {
      ok: true,
      value:
        input.path === "/login/other"
          ? { result: "password-changed", accountId: other.accountId }
          : {
              result: "password-changed",
              accountId: acme.accountId,
              choices: [acme.accountId, other.accountId],
            },
    };
  }) as never;
  const listeners = new Set<
    (capture: Parameters<Parameters<DesktopAccountsBridge["onSignInCaptured"]>[0]>[0]) => void
  >();
  const bridge: DesktopAccountsBridge = {
    sourceProfiles: async () => [],
    signedInSites: async () => [],
    fill: async () => false,
    onSignInCaptured: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const previous = Object.getOwnPropertyDescriptor(window, "desktopBridge");
  using _bridge = {
    [Symbol.dispose]() {
      if (previous) Object.defineProperty(window, "desktopBridge", previous);
      else Reflect.deleteProperty(window, "desktopBridge");
    },
  };
  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    value: { accounts: bridge },
  });
  state.snapshot = {
    agentAccess: true,
    accounts: [acme, other],
    profiles: [],
    stores: {
      scient: { protection: "keychain" },
      keychain: { available: false, platform: "linux" },
      onePassword: { state: "not-connected" },
    },
    approvals: [],
    recentActivity: [],
    customModelKeys: [],
    accountsProtocol: 2,
  };
  const environmentId = EnvironmentId.make("synthetic");
  await using _screen = await render(
    <BrowserAccountControls
      environmentId={environmentId}
      threadRef={{ environmentId, threadId: ThreadId.make("synthetic-thread") }}
      tabId="synthetic-tab"
      profileId="default"
      url="https://example.com/login"
    />,
  );
  const capture = (path: string) =>
    act(async () => {
      for (const listener of listeners)
        listener({
          tabId: "synthetic-tab",
          profileId: "default",
          url: "https://example.com",
          path,
          step: "password",
          username: "synthetic",
          password: "synthetic-password",
          usernameFrom: "form",
        });
    });
  await capture("/login");
  await page.getByRole("button", { name: "/login/acme" }).click();
  // The next capture is Other's own login: no card asks, whatever was picked before, and
  // nothing is written until the sign-in is seen to work.
  await capture("/login/other");
  await expect.element(page.getByRole("button", { name: "/login/acme" })).not.toBeInTheDocument();
  expect(page.getByRole("button", { name: "Update" }).elements()).toHaveLength(0);
  expect(saved).toEqual([]);
});

/**
 * One sign-in sent from example.com/login, answered by the server with `result`, and the page
 * the tab is on once it settles.
 */
async function signInSent(options: {
  readonly result: "password-changed" | "new";
  readonly username: string;
  /** What the tab shows at each look; the last one stays. */
  readonly signInPage: DesktopSignInPage | ReadonlyArray<DesktopSignInPage>;
  /** The site set a new sign-in cookie after the form was sent. */
  readonly newCookie?: boolean;
  /** The site's cookies at each read, the first as the form was sent (round 6c). */
  readonly cookies?: (read: number) => ReadonlyArray<{
    readonly domain: string;
    readonly httpOnly?: boolean;
    readonly name?: string;
    readonly digest?: string;
  }>;
}) {
  setup();
  state.toasts = [];
  const lab = {
    accountId: AccountId.make("acc_synthetic_lab"),
    name: "Synthetic",
    details: { kind: "website" as const, sites: ["https://example.com"], username: "synthetic" },
    secrets: {
      password: {
        source: { type: "scient" as const },
        ...(options.result === "new" ? { refusedAt: "2026-10-26T00:00:00.000Z" } : {}),
      },
    },
    controls: defaultAccountControls("website"),
    status: "ready" as const,
    createdAt: "2026-10-26T00:00:00.000Z",
    updatedAt: "2026-10-26T00:00:00.000Z",
  };
  const saved: Array<{ accountId?: string; secrets?: unknown }> = [];
  const seen: Array<unknown> = [];
  const looks: string[] = [];
  let cookieReads = 0;
  state.request = (async (input: {
    path?: string;
    accountId?: string;
    secrets?: unknown;
    outcome?: string;
  }) => {
    if (input.secrets !== undefined) {
      saved.push(input);
      return {
        ok: true,
        value: { account: { ...lab, accountId: AccountId.make("acc_synthetic_new") } },
      };
    }
    if (input.outcome !== undefined) {
      seen.push(input);
      return { ok: true, value: {} };
    }
    if (input.path === undefined) return { ok: true, value: {} };
    return {
      ok: true,
      value:
        options.result === "new"
          ? { result: "new" }
          : { result: "password-changed", accountId: lab.accountId },
    };
  }) as never;
  const listeners = new Set<
    (capture: Parameters<Parameters<DesktopAccountsBridge["onSignInCaptured"]>[0]>[0]) => void
  >();
  const bridge: DesktopAccountsBridge = {
    sourceProfiles: async () => [],
    signedInSites: async () => [],
    fill: async () => false,
    loginForm: async () => null,
    signInPage: async (tabId) => {
      looks.push(tabId);
      const pages = "state" in options.signInPage ? [options.signInPage] : options.signInPage;
      return pages[Math.min(looks.length, pages.length) - 1]!;
    },
    cookieMetadata: async () =>
      options.cookies
        ? options.cookies(cookieReads++)
        : cookieReads++ > 0 && options.newCookie !== false
          ? [{ domain: "example.com", httpOnly: true, name: "session", path: "/", digest: "new" }]
          : [],
    onSignInCaptured: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const previous = Object.getOwnPropertyDescriptor(window, "desktopBridge");
  const restore = {
    [Symbol.dispose]() {
      if (previous) Object.defineProperty(window, "desktopBridge", previous);
      else Reflect.deleteProperty(window, "desktopBridge");
    },
  };
  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    value: { accounts: bridge },
  });
  state.snapshot = {
    agentAccess: true,
    accounts: [lab],
    profiles: [],
    stores: {
      scient: { protection: "keychain" },
      keychain: { available: false, platform: "linux" },
      onePassword: { state: "not-connected" },
    },
    approvals: [],
    recentActivity: [],
    customModelKeys: [],
    accountsProtocol: 2,
  };
  const environmentId = EnvironmentId.make("synthetic");
  const screen = await render(
    <BrowserAccountControls
      environmentId={environmentId}
      threadRef={{ environmentId, threadId: ThreadId.make("synthetic-thread") }}
      tabId="synthetic-tab"
      profileId="default"
      url="https://example.com/login"
    />,
  );
  await act(async () => {
    for (const listener of listeners)
      listener({
        tabId: "synthetic-tab",
        profileId: "default",
        url: "https://example.com",
        path: "/login",
        step: "password",
        username: options.username,
        password: "synthetic-new-password",
        usernameFrom: "form",
      });
  });
  // regression: the owner got an "Update password?" card for their own login.
  expect(page.getByRole("button", { name: "Update" }).elements()).toHaveLength(0);
  // The tab is looked at once the site has had time to answer, until it shows where it ended.
  const pages = "state" in options.signInPage ? 1 : options.signInPage.length;
  await expect
    .poll(() => looks.length, { timeout: 15_000 + pages * 3_000 })
    .toBeGreaterThanOrEqual(pages);
  await act(async () => undefined);
  return {
    lab,
    saved,
    seen,
    async [Symbol.asyncDispose]() {
      await screen[Symbol.asyncDispose]();
      restore[Symbol.dispose]();
    },
  };
}

it("updates the same login once its new password works, with no card", async () => {
  await using sent = await signInSent({
    result: "password-changed",
    username: "synthetic",
    signInPage: { state: "done", url: "https://example.com/home" },
  });
  await expect
    .poll(() => sent.saved)
    .toEqual([
      expect.objectContaining({
        accountId: sent.lab.accountId,
        secrets: { password: { type: "scient", value: "synthetic-new-password" } },
      }),
    ]);
  expect(sent.seen).toContainEqual(expect.objectContaining({ accountId: sent.lab.accountId }));
  // Accounts tells it, with an Undo for each copy's own earlier password (passwordUpdates.ts).
  expect(state.toasts).toHaveLength(0);
});

it("saves a new username where the saved one was refused, once signed in, with Undo", async () => {
  await using sent = await signInSent({
    result: "new",
    username: "synthetic-other",
    signInPage: { state: "done", url: "https://example.com/home" },
  });
  await expect.poll(() => sent.saved).toHaveLength(1);
  expect(sent.saved[0]).not.toHaveProperty("accountId");
  await expect
    .poll(() => state.toasts.map((toast) => toast.title))
    .toEqual(["Saved synthetic-other"]);
});

it("follows a sign-in through its code step and saves once it is past it", async () => {
  await using sent = await signInSent({
    result: "password-changed",
    username: "synthetic",
    // regression: the first look at the code step ended the check, and nothing was saved.
    signInPage: [
      { state: "code", url: "https://example.com/verify" },
      { state: "code", url: "https://example.com/verify" },
      { state: "done", url: "https://example.com/home" },
    ],
  });
  await expect.poll(() => sent.saved).toHaveLength(1);
});

const unfinished = [
  // A code step the site then refused: back at the login, nothing worked.
  {
    signInPage: [
      { state: "code", url: "https://example.com/verify" },
      { state: "login", url: "https://example.com/login" },
    ],
  },
  { signInPage: { state: "done", url: "https://example.com/login" } },
  { signInPage: { state: "login", url: "https://example.com/home" } },
  // regression: a fieldless refusal page on a new path read as success.
  { signInPage: { state: "done", url: "https://example.com/error" }, newCookie: false },
] as const;
it.each(
  (["password-changed", "new"] as const).flatMap((result) =>
    unfinished.map((page, index) => ({ result, page, index })),
  ),
)(
  "writes nothing for $result when the sign-in didn't finish (case $index)",
  async ({ result, page }) => {
    const username = result === "new" ? "synthetic-other" : "synthetic";
    await using sent = await signInSent({ result, username, ...page });
    expect(sent.saved).toEqual([]);
    expect(state.toasts).toEqual([]);
  },
);

describe("only an authenticated session says it worked (round 6c, finding 10)", () => {
  const session = (name: string, digest: string) => ({
    domain: "example.com",
    httpOnly: true,
    name,
    path: "/",
    digest,
  });
  it("writes nothing when a refusal page only set a bot check's cookie", async () => {
    await using sent = await signInSent({
      result: "password-changed",
      username: "synthetic",
      signInPage: { state: "done", url: "https://example.com/locked" },
      cookies: (read) => (read === 0 ? [] : [session("__cf_bm", "aaaa")]),
    });
    expect(sent.saved).toEqual([]);
  });

  it("asks the person with the card when a settled page only set a flow's state cookie", async () => {
    await using sent = await signInSent({
      result: "password-changed",
      username: "synthetic",
      signInPage: { state: "done", url: "https://example.com/oops" },
      // regression: a fieldless refusal that set an HttpOnly state cookie saved the password.
      cookies: (read) => (read === 0 ? [] : [session("oauth_state", "aaaa")]),
    });
    await expect
      .element(page.getByRole("button", { name: "Update" }), { timeout: 15_000 })
      .toBeVisible();
    expect(sent.saved).toEqual([]);
  });

  it("saves once the code step rotated the session in place", async () => {
    await using sent = await signInSent({
      result: "password-changed",
      username: "synthetic",
      signInPage: [
        { state: "code", url: "https://example.com/verify" },
        { state: "done", url: "https://example.com/home" },
      ],
      // The same cookie, same domain and expiry, with a new value.
      cookies: (read) => [session("session", read === 0 ? "before" : "after")],
    });
    await expect.poll(() => sent.saved).toHaveLength(1);
  });

  it("asks the person every time a sign-in shows only a generic cookie (round 6h)", async () => {
    for (let time = 0; time < 2; time++) {
      await using sent = await signInSent({
        result: "password-changed",
        username: "synthetic",
        signInPage: { state: "done", url: "https://example.com/home" },
        cookies: (read) => (read === 0 ? [] : [session("ex_k", "aaaa")]),
      });
      // regression: a Save taught the site's cookie, and the next sign-in saved unasked.
      await expect
        .element(page.getByRole("button", { name: "Update" }), { timeout: 15_000 })
        .toBeVisible();
      if (time === 0) {
        await page.getByRole("button", { name: "Update" }).click();
        await expect.poll(() => sent.saved).toHaveLength(1);
      } else expect(sent.saved).toEqual([]);
    }
  });

  it("follows the page until the session arrives, a moment after it settled", async () => {
    await using sent = await signInSent({
      result: "password-changed",
      username: "synthetic",
      // Settled at the first look with no session yet; it comes by the second.
      signInPage: [
        { state: "done", url: "https://example.com/home" },
        { state: "done", url: "https://example.com/home" },
      ],
      cookies: (read) => (read < 2 ? [] : [session("session", "late")]),
    });
    await expect.poll(() => sent.saved, { timeout: 10_000 }).toHaveLength(1);
  });
});
