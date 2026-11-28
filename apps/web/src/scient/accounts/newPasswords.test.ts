import {
  AccountId,
  EnvironmentId,
  type AccountSummary,
  type DesktopCapturedSignIn,
  type DesktopLoginForm,
  type DesktopSignInPage,
  type DesktopSubmitAnswer,
} from "@t3tools/contracts";
import { AtomRegistry } from "effect/reactivity";
import { afterEach, expect, it, vi } from "vite-plus/test";

import {
  fillStrongPassword,
  heldPasswordFor,
  keepMadePassword,
  wantPasswordFix,
  watchPasswordFixes,
} from "./newPasswords";

/** Whether the server holds a made password before its fill, as its snapshot says. */
const speaks = vi.hoisted(() => ({ reserve: true }));
vi.mock("./accountsState", async () => {
  const { AsyncResult, Atom } = await import("effect/reactivity");
  return {
    accountsState: {
      snapshot: () =>
        Atom.make(() =>
          AsyncResult.success({
            accountsProtocol: 3,
            pendingFeatures: speaks.reserve ? ["reserve"] : [],
          }),
        ),
    },
  };
});
const preview = vi.hoisted(() => ({ owner: undefined as string | undefined }));
vi.mock("~/previewStateStore", () => ({
  readThreadPreviewState: () => ({
    serverEpoch: 1,
    sessions: { "tab-fixture": { automationOwner: preview.owner } },
  }),
}));
/** What went to the server: each command's arguments. */
const commands = vi.hoisted(() => [] as unknown[]);
/** The toasts the person saw. */
const toasts = vi.hoisted(() => [] as unknown[]);
vi.mock("~/components/ui/toast", () => ({
  toastManager: { add: (toast: { title: unknown }) => toasts.push(toast.title) },
}));
/** Runs as a command reaches the server: the world changing while it is answered. */
const hooks = vi.hoisted(() => ({
  onCommand: undefined as (() => void) | undefined,
  /** Accounts holds too many new passwords to take another. */
  full: false,
  /** The last new password Accounts held. */
  lastReserved: undefined as string | undefined,
}));
// Hoisted above the imports, so the factory loads what it needs itself.
vi.mock("@t3tools/client-runtime/state/runtime", async (importOriginal) => {
  const { AsyncResult } = await import("effect/reactivity");
  const Cause = await import("effect/Cause");
  const { AccountsError } = await import("@t3tools/contracts");
  let reserved = 0;
  return {
    ...(await importOriginal<object>()),
    runAtomCommand: async (_registry: unknown, _command: unknown, args: unknown) => {
      commands.push(args);
      hooks.onCommand?.();
      const type = (args as { input?: { type?: string } }).input?.type;
      if (type === "reserve")
        return hooks.full
          ? AsyncResult.failure(
              Cause.fail(
                new AccountsError({
                  reason: "unavailable",
                  message: "Too many new passwords wait. Answer some first.",
                }),
              ),
            )
          : AsyncResult.success({ pendingId: (hooks.lastReserved = `reserved-${++reserved}`) });
      return AsyncResult.success({ password: "synthetic-saved" });
    },
  };
});

const origin = "https://shop.example.com";
const environmentId = EnvironmentId.make("environment-fixture");
const runtimeTabId = (tabId: string) => JSON.stringify([environmentId, "thread-fixture", 1, tabId]);
const tab = runtimeTabId("tab-fixture");
const form = (documentId: string, refusal = false, tabId = tab): DesktopLoginForm => ({
  tabId,
  profileId: "default",
  url: origin,
  documentId,
  userEdited: false,
  hasPassword: false,
  hasValues: false,
  boxes: [],
  newPassword: {
    minLength: -1,
    maxLength: -1,
    pattern: "",
    passwordRules: "",
    statedMinLength: 12,
    statedMaxLength: -1,
    required: [],
    noSymbols: false,
    refusal,
  },
});
const login = (id: string, username: string) =>
  ({
    accountId: AccountId.make(id),
    name: "Shop",
    updatedAt: "2026-11-26T10:00:00.000Z",
    details: { kind: "website", sites: ["shop.example.com"], username },
    secrets: { password: { source: { type: "scient" } } },
  }) as unknown as AccountSummary;
const ada = login("acc_shop_ada01", "ada");
const bea = login("acc_shop_bea01", "bea");

/**
 * The desktop's side: a tab reporting `forms`, its fills recorded. `submitted` is the answer the
 * desktop read to the form's own request (doc-1's), a success unless said; null, none.
 */
function desktop(
  forms: ReadonlyArray<DesktopLoginForm | null>,
  submitted: Partial<DesktopSubmitAnswer> | null = null,
) {
  let look = 0;
  const fills: Array<Record<string, unknown>> = [];
  let report: ((form: DesktopLoginForm) => void) | undefined;
  const reported = new Map<string, DesktopLoginForm>();
  const seeks: Array<[string, string]> = [];
  vi.stubGlobal("window", {
    desktopBridge: {
      accounts: {
        signInPage: async (): Promise<DesktopSignInPage> => ({
          state: "done",
          url: `${origin}/settings`,
          ...(submitted
            ? {
                submitted: {
                  documentId: "doc-1",
                  status: 200,
                  formGone: true,
                  refusal: false,
                  leftOrigin: false,
                  ...submitted,
                },
              }
            : {}),
        }),
        // The steps given, or else what the tab last reported.
        loginForm: async (tabId: string) =>
          forms.length
            ? (forms[Math.min(look++, forms.length - 1)] ?? null)
            : (reported.get(tabId) ?? null),
        onLoginFormDetected: (listener: (form: DesktopLoginForm) => void) => {
          report = listener;
          return () => undefined;
        },
        fill: async (input: Record<string, unknown>) => {
          fills.push(input);
          return true;
        },
        seekPasswordPage: async (tabId: string, to: string) => {
          seeks.push([tabId, to]);
          return true;
        },
      },
    },
  });
  return {
    fills,
    seeks,
    report: (shown: DesktopLoginForm) => {
      reported.set(shown.tabId, shown);
      report!(shown);
    },
  };
}

/**
 * Accounts as the server keeps them: each login's password, and the new passwords it holds
 * apart until their site's answer settles them.
 */
function server() {
  const passwords = new Map<string, string>([
    [ada.accountId, "ada-old"],
    [bea.accountId, "bea-old"],
  ]);
  const pending = new Map<string, { readonly accountId: string; readonly password: string }>();
  let failing = 0;
  return {
    passwords,
    pending,
    failNext: (times: number) => (failing = times),
    actions: {
      rotate: async (
        accountId: AccountId | undefined,
        capture: DesktopCapturedSignIn,
        _reserved: string,
      ) => {
        if (failing > 0) return ((failing -= 1), undefined);
        const pendingId = `pending-${pending.size}`;
        pending.set(pendingId, {
          accountId: accountId ?? `acc_new_${capture.username}`,
          password: capture.password,
        });
        return pendingId;
      },
      settle: async (pendingId: string, outcome: "accepted" | "unclear") => {
        const held = pending.get(pendingId)!;
        if (outcome === "accepted") passwords.set(held.accountId, held.password);
        if (outcome !== "unclear") pending.delete(pendingId);
        return true;
      },
    },
  };
}

/** Scient fills the form (as a Fix of `account`) and the person submits it with `username`. */
async function filledAndSent(account: AccountSummary | undefined, username: string) {
  const shown = desktop([form("doc-1")]);
  expect(await fillStrongPassword(AtomRegistry.make(), environmentId, form("doc-1"), account)).toBe(
    true,
  );
  const password = String(shown.fills.at(-1)!.newPassword);
  const capture: DesktopCapturedSignIn = {
    tabId: tab,
    profileId: "default",
    url: origin,
    path: "/settings/password",
    step: "password",
    username,
    password: "",
    newPassword: password,
    usernameFrom: "form",
  };
  return { password, capture, made: heldPasswordFor(tab, origin, password)! };
}

const settle = async (promise: Promise<"accepted" | "unclear" | "unsaved">) => {
  await vi.runAllTimersAsync();
  return promise;
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  preview.owner = undefined;
  speaks.reserve = true;
  commands.length = 0;
  toasts.length = 0;
});

it("takes an ordinary success in the person's two actions, and never loses either password", async () => {
  vi.useFakeTimers();
  const accounts = server();
  const sameSite = [ada, bea];
  const send = (made: ReturnType<typeof filledAndSent> extends Promise<infer A> ? A : never) =>
    settle(keepMadePassword(tab, made.made, made.capture, sameSite, accounts.actions));
  // Fix fills, the person submits; the desktop saw the form's own request succeed and its form
  // go (a single-page app's fetch or a full-page post alike): accepted, saved, released.
  let sent = await filledAndSent(ada, "ada");
  desktop([], {});
  expect(await send(sent)).toBe("accepted");
  expect(accounts.passwords.get(ada.accountId)).toBe(sent.password);
  expect(heldPasswordFor(tab, origin, sent.password)).toBeUndefined();
  const working = sent.password;
  // A failed change (its form still shown, saying so), then a visit elsewhere on the site: the
  // answer to the submit stays unclear. The login keeps the password that works; the new one
  // waits, held, for the person, and for the corrected submit, which the site takes.
  sent = await filledAndSent(ada, "ada");
  desktop([], { formGone: false, refusal: true });
  expect(await send(sent)).toBe("unclear");
  expect(accounts.passwords.get(ada.accountId)).toBe(working);
  expect([...accounts.pending.values()]).toEqual([
    { accountId: ada.accountId, password: sent.password },
  ]);
  expect(heldPasswordFor(tab, origin, sent.password)).toBe(sent.made);
  accounts.pending.clear();
  desktop([], {});
  expect(await send(sent)).toBe("accepted");
  expect(accounts.passwords.get(ada.accountId)).toBe(sent.password);
  // No answer tied to the submit (an older desktop, a form it didn't see sent), an error, or a
  // page on another site: unclear, nothing changed.
  for (const answer of [null, { status: 500 }, { leftOrigin: true }, { documentId: "doc-0" }]) {
    sent = await filledAndSent(ada, "ada");
    const before = accounts.passwords.get(ada.accountId);
    desktop([], answer);
    expect(await send(sent)).toBe("unclear");
    expect(accounts.passwords.get(ada.accountId)).toBe(before);
  }
  // Word of the submit couldn't reach Accounts, tried twice: the made password stays held.
  accounts.failNext(2);
  expect(await send(sent)).toBe("unsaved");
  expect(heldPasswordFor(tab, origin, sent.password)).toBe(sent.made);
  // Once only: the second try reaches it.
  accounts.failNext(1);
  desktop([], {});
  expect(await send(sent)).toBe("accepted");
});

it("fills nothing when Accounts can't hold the new password first, and says so", async () => {
  const shown = desktop([form("doc-1")]);
  hooks.full = true;
  try {
    expect(await fillStrongPassword(AtomRegistry.make(), environmentId, form("doc-1"), ada)).toBe(
      "unheld",
    );
    expect(shown.fills).toEqual([]);
    expect(toasts).toEqual(["Too many new passwords wait. Answer some first."]);
  } finally {
    hooks.full = false;
  }
});

it("forgets a made password its tab never sent when the tab fills another", async () => {
  const shown = desktop([form("doc-1"), form("doc-2")]);
  await fillStrongPassword(AtomRegistry.make(), environmentId, form("doc-1"), ada);
  await fillStrongPassword(AtomRegistry.make(), environmentId, form("doc-2"), ada);
  const inputs = commands.map((args) => (args as { input: { type?: string } }).input);
  const steps = inputs.filter((input) => input.type !== undefined);
  expect(steps.map((input) => input.type)).toEqual(["reserve", "reserve", "discard"]);
  // The one forgotten is the first; the second stays held for its submit.
  const second = heldPasswordFor(tab, origin, String(shown.fills.at(-1)!.newPassword))!;
  expect(steps.at(-1)).not.toMatchObject({ pendingId: second.pendingId });
});

it("never saves a Fix's password into its login when the form names another account", async () => {
  vi.useFakeTimers();
  const accounts = server();
  const sent = await filledAndSent(ada, "bea");
  desktop([], {});
  await settle(keepMadePassword(tab, sent.made, sent.capture, [ada, bea], accounts.actions));
  expect(accounts.passwords.get(ada.accountId)).toBe("ada-old");
  expect(accounts.passwords.get(bea.accountId)).toBe(sent.password);
});

it("fills a Fix's change page only in the tab it opened, never an agent's, as that login", async () => {
  const shown = desktop([]);
  const stop = watchPasswordFixes(AtomRegistry.make(), environmentId);
  // The change form shows before the Fix knows its tab: it fills once the tab is known.
  shown.report(form("doc-1"));
  // Pressed "now" for the watcher, which reads the real clock: any time ahead of it will do.
  const at = Date.parse("2999-01-01T00:00:00Z");
  const opened = { environmentId, threadId: "thread-fixture", tabId: "tab-fixture", origin };
  wantPasswordFix(ada, opened, at);
  await vi.waitFor(() => expect(shown.fills).toHaveLength(1));
  expect(shown.fills[0]).toMatchObject({
    tabId: tab,
    password: "synthetic-saved",
    username: "ada",
    expectedOrigin: origin,
  });
  // The tab moves on from its change page. Then another tab on the same site, or the Fix's tab
  // once an agent controls it: nothing asked of Accounts, nothing typed; the agent's tab ends
  // that Fix. A new Fix fills again.
  const { newPassword: _none, ...moved } = form("doc-2");
  shown.report(moved);
  wantPasswordFix(ada, opened, at);
  commands.length = 0;
  shown.report(form("doc-2", false, runtimeTabId("tab-other")));
  preview.owner = "agent-fixture";
  shown.report(form("doc-3"));
  preview.owner = undefined;
  expect(commands).toEqual([]);
  shown.report(form("doc-4"));
  expect(commands).toEqual([]);
  wantPasswordFix(ada, opened, at);
  await vi.waitFor(() => expect(shown.fills).toHaveLength(2));
  expect(shown.fills.map((fill) => [fill.tabId, fill.documentId])).toEqual([
    [tab, "doc-1"],
    [tab, "doc-4"],
  ]);
  stop();
});

it("takes a Fix's tab to the site's own change page on the origin it opened, after a while", async () => {
  vi.useFakeTimers();
  const shown = desktop([]);
  const stop = watchPasswordFixes(AtomRegistry.make(), environmentId);
  const opened = {
    environmentId,
    threadId: "thread-fixture",
    tabId: "tab-fixture",
    origin,
  };
  wantPasswordFix(ada, opened, Date.parse("2999-01-01T00:00:00Z"));
  await vi.advanceTimersByTimeAsync(6_000);
  expect(shown.seeks).toEqual([[tab, origin]]);
  stop();
});

it("types nothing when an agent takes the tab while the login's values are fetched", async () => {
  const shown = desktop([form("doc-1")]);
  hooks.onCommand = () => {
    preview.owner = "agent-fixture";
  };
  try {
    expect(await fillStrongPassword(AtomRegistry.make(), environmentId, form("doc-1"), ada)).toBe(
      false,
    );
    expect(shown.fills).toEqual([]);
  } finally {
    hooks.onCommand = undefined;
  }
});

it("makes no password for a server that can't hold it before its fill (a round-3 v3 one)", async () => {
  const shown = desktop([form("doc-1")]);
  speaks.reserve = false;
  expect(await fillStrongPassword(AtomRegistry.make(), environmentId, form("doc-1"), ada)).toBe(
    false,
  );
  expect(shown.fills).toEqual([]);
});

it("fills a Fix only on the origin it opened, never another of the login's sites", async () => {
  const shown = desktop([]);
  const stop = watchPasswordFixes(AtomRegistry.make(), environmentId);
  const twoSites = {
    ...ada,
    details: {
      kind: "website",
      sites: ["shop.example.com", "accounts.example.net"],
      username: "ada",
    },
  } as unknown as AccountSummary;
  const opened = { environmentId, threadId: "thread-fixture", tabId: "tab-fixture", origin };
  wantPasswordFix(twoSites, opened, Date.parse("2999-01-01T00:00:00Z"));
  // The Fix's tab went on to the login's other site (a redirect): its change form gets nothing.
  shown.report({ ...form("doc-1"), url: "https://accounts.example.net" });
  await vi.waitFor(() => expect(commands).toEqual([]));
  expect(shown.fills).toEqual([]);
  shown.report(form("doc-2"));
  await vi.waitFor(() => expect(shown.fills).toHaveLength(1));
  stop();
});

it("keeps the held password when the desktop's answer to a fill is lost after typing", async () => {
  desktop([form("doc-1")]);
  const accounts = (window as unknown as { desktopBridge: { accounts: Record<string, unknown> } })
    .desktopBridge.accounts;
  accounts.fill = async () => {
    throw new Error("the window went away mid-answer");
  };
  expect(await fillStrongPassword(AtomRegistry.make(), environmentId, form("doc-1"), ada)).toBe(
    true,
  );
  const lost = hooks.lastReserved;
  // The capture never came; the next fill in the tab (another made password) answers as usual.
  accounts.fill = async () => true;
  expect(await fillStrongPassword(AtomRegistry.make(), environmentId, form("doc-1"), ada)).toBe(
    true,
  );
  // The reservation it may have typed is never discarded, at the fill or by a later one.
  const discarded = commands
    .map((args) => (args as { input: { type?: string; pendingId?: string } }).input)
    .filter((input) => input.type === "discard")
    .map((input) => input.pendingId);
  expect(discarded).not.toContain(lost);
});
