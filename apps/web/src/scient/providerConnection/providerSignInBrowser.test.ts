import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderConnectionOperation,
  type ServerProvider,
} from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const toast = vi.hoisted(() => ({ add: vi.fn() }));
vi.mock("../../components/ui/toast", () => ({ toastManager: toast }));

import {
  observeProviderSignInSnapshots,
  resetProviderSignInBrowserForTests,
  startProviderSignIn,
} from "./providerSignInBrowser";

const environmentId = EnvironmentId.make("environment-1");
const instanceId = ProviderInstanceId.make("antigravity");
const key = { environmentId, instanceId };
const url = "https://accounts.google.com/o/oauth2/v2/auth?client_id=synthetic-test";
const STORAGE_KEY = "scient.providerSignIn.pendingRequests.v1";

function operation(patch: Partial<ProviderConnectionOperation> = {}): ProviderConnectionOperation {
  return {
    operationId: "connect-1",
    method: "antigravity_google",
    status: "waiting_for_browser",
    startedAt: "2026-10-18T00:00:00.000Z",
    finishedAt: null,
    message: "Finish signing in.",
    authorizationUrl: url,
    authorizationUrlKind: "primary",
    ...patch,
  };
}

function provider(current: ProviderConnectionOperation): ServerProvider {
  return {
    instanceId,
    driver: ProviderDriverKind.make("antigravity"),
    displayName: "Antigravity",
    enabled: true,
    installed: true,
    version: "1.1.17",
    status: "warning",
    auth: { status: "unauthenticated", required: true },
    checkedAt: "2026-10-18T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    connection: { methods: ["antigravity_google"], canDisconnect: false, operation: current },
  };
}

class MemoryStorage {
  readonly values = new Map<string, string>();
  get length() {
    return this.values.size;
  }
  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }
  clone() {
    const copy = new MemoryStorage();
    for (const [name, value] of this.values) copy.values.set(name, value);
    return copy;
  }
  getItem(name: string) {
    return this.values.get(name) ?? null;
  }
  setItem(name: string, value: string) {
    this.values.set(name, value);
  }
  removeItem(name: string) {
    this.values.delete(name);
  }
}

const realLocks = globalThis.navigator.locks;
const open = vi.fn<(url: string) => Promise<void>>();
let storage: MemoryStorage;
let shared: MemoryStorage;
const windowOpen = vi.fn<(url: string, target: string, features: string) => unknown>();

/** Web Locks with `ifAvailable`, shared by every window of the test. */
function fakeLocks() {
  const held = new Set<string>();
  return {
    request: async <T>(
      name: string,
      _options: { readonly ifAvailable: boolean },
      callback: (lock: { readonly name: string } | null) => T | Promise<T>,
    ) => {
      if (held.has(name)) return callback(null);
      held.add(name);
      try {
        await Promise.resolve();
        return await callback({ name });
      } finally {
        held.delete(name);
      }
    },
  };
}
let clock = 0;
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Starts a sign-in whose server stamps the request id on the operation it returns. */
function start(
  reply: (signInRequestId: string) => Promise<ProviderConnectionOperation | null>,
  previousOperationId: string | null = null,
) {
  return startProviderSignIn({
    key,
    providerName: "Antigravity",
    previousOperationId,
    start: reply,
    operationOf: (value) => value,
  });
}

/** A start whose reply never arrives; resolves with the id the server received. */
function startWithLostReply() {
  return new Promise<string>((received) => {
    void start((signInRequestId) => {
      received(signInRequestId);
      return new Promise<never>(() => undefined);
    });
  });
}

const observe = (current: ProviderConnectionOperation) =>
  observeProviderSignInSnapshots(environmentId, [provider(current)]);

beforeEach(() => {
  vi.resetAllMocks();
  open.mockResolvedValue(undefined);
  storage = new MemoryStorage();
  shared = new MemoryStorage();
  windowOpen.mockReset();
  vi.stubGlobal("window", { sessionStorage: storage, localStorage: shared, open: windowOpen });
  vi.stubGlobal("navigator", { locks: fakeLocks() });
  clock = Date.now();
  resetProviderSignInBrowserForTests({ open, now: () => clock });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("provider sign-in page opening", () => {
  it("opens the page of an operation this client started, once", async () => {
    await start(async (id) => operation({ signInRequestId: id }));
    // The same snapshot streamed afterwards does not open it again.
    observe(operation({ signInRequestId: "already-released" }));
    await settle();
    expect(open.mock.calls).toEqual([[url]]);
    expect(storage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("opens from the stream when the start reply is lost", async () => {
    const id = await startWithLostReply();
    const { authorizationUrl: _url, ...starting } = operation({
      status: "starting",
      signInRequestId: id,
    });
    observe(starting);
    await settle();
    expect(open).not.toHaveBeenCalled();

    observe(operation({ signInRequestId: id }));
    observe(operation({ signInRequestId: id }));
    await settle();
    expect(open.mock.calls).toEqual([[url]]);
  });

  it("opens once after a renderer reload during the slow start", async () => {
    const id = await startWithLostReply();
    expect(storage.getItem(STORAGE_KEY)).toContain(id);

    resetProviderSignInBrowserForTests({ open, now: () => clock, reload: true });
    observe(operation({ signInRequestId: id }));
    await settle();
    expect(open).toHaveBeenCalledTimes(1);

    // Another reload after the page opened does not open it again.
    resetProviderSignInBrowserForTests({ open, now: () => clock, reload: true });
    observe(operation({ signInRequestId: id }));
    await settle();
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("never opens another client's sign-in", async () => {
    await startWithLostReply();
    observe(operation({ signInRequestId: "another-client-request" }));
    observe(operation());
    await settle();
    expect(open).not.toHaveBeenCalled();
  });

  it("opens once when two starts from this client join one operation", async () => {
    let first: string | undefined;
    const reply = new Promise<ProviderConnectionOperation>((resolve) =>
      setTimeout(() => resolve(operation({ signInRequestId: first! })), 0),
    );
    // As the command's single flight does: the second caller shares the first reply.
    await Promise.all([
      start((id) => {
        first = id;
        return reply;
      }),
      start(() => reply),
    ]);
    expect(open).toHaveBeenCalledTimes(1);
    expect(storage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("drops ids of expired or finished operations", async () => {
    const expired = await startWithLostReply();
    clock += 16 * 60_000;
    observe(operation({ signInRequestId: expired }));
    await settle();
    expect(open).not.toHaveBeenCalled();
    expect(storage.getItem(STORAGE_KEY)).toBeNull();

    const finished = await startWithLostReply();
    observe(operation({ status: "failed", signInRequestId: finished }));
    observe(operation({ signInRequestId: finished }));
    await settle();
    expect(open).not.toHaveBeenCalled();
    expect(storage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("keeps the id when the start fails with an unknown outcome", async () => {
    let sent: string | undefined;
    await expect(
      start((id) => {
        sent = id;
        return Promise.reject(new Error("The environment connection closed."));
      }),
    ).rejects.toThrow("connection closed");
    observe(operation({ signInRequestId: sent! }));
    await settle();
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("releases the id of a start the server rejected", async () => {
    await expect(
      start(() => Promise.reject({ _tag: "ProviderConnectionError", message: "Already running." })),
    ).rejects.toMatchObject({ _tag: "ProviderConnectionError" });
    expect(storage.getItem(STORAGE_KEY)).toBeNull();
    expect(open).not.toHaveBeenCalled();
  });

  it("does not open what must not open", async () => {
    for (const current of [
      operation({ authorizationUrlKind: "manual_fallback" }),
      operation({ status: "verifying" }),
      operation({ status: "cancelled" }),
    ]) {
      await start(async (id) => ({ ...current, signInRequestId: id }));
    }
    expect(open).not.toHaveBeenCalled();
  });

  it("uses the reply alone with a server that does not stamp request ids", async () => {
    await start(async () => operation(), "connect-1");
    expect(open).not.toHaveBeenCalled();
    await start(async () => operation());
    await start(async () => operation());
    expect(open).toHaveBeenCalledTimes(1);
    expect(storage.getItem(STORAGE_KEY)).toBeNull();
  });

  /** A second window opened from this one: a copy of its session storage, the same local storage. */
  async function openSecondWindow(
    options: { readonly beforeClaimRecord?: () => Promise<void> } = {},
  ) {
    const copied = storage.clone();
    vi.resetModules();
    vi.stubGlobal("window", { sessionStorage: copied, localStorage: shared, open: windowOpen });
    const second = await import("./providerSignInBrowser");
    expect(second.observeProviderSignInSnapshots).not.toBe(observeProviderSignInSnapshots);
    second.resetProviderSignInBrowserForTests({ open, now: () => clock, reload: true, ...options });
    vi.stubGlobal("window", { sessionStorage: storage, localStorage: shared, open: windowOpen });
    return {
      observe: (current: ProviderConnectionOperation) => {
        vi.stubGlobal("window", { sessionStorage: copied, localStorage: shared, open: windowOpen });
        second.observeProviderSignInSnapshots(environmentId, [provider(current)]);
        vi.stubGlobal("window", {
          sessionStorage: storage,
          localStorage: shared,
          open: windowOpen,
        });
      },
    };
  }

  it("opens once across windows whose claims overlap, under the real Web Locks", async () => {
    vi.stubGlobal("navigator", { locks: realLocks });
    const id = await startWithLostReply();
    // The first window pauses inside its claim, between the check and the record.
    let resume!: () => void;
    let paused!: () => void;
    const inside = new Promise<void>((resolve) => (paused = resolve));
    resetProviderSignInBrowserForTests({
      open,
      now: () => clock,
      reload: true,
      beforeClaimRecord: () =>
        new Promise<void>((resolve) => {
          resume = resolve;
          paused();
        }),
    });
    const second = await openSecondWindow();

    observe(operation({ signInRequestId: id }));
    await inside;
    second.observe(operation({ signInRequestId: id }));
    await settle();
    expect(open).not.toHaveBeenCalled();
    resume();
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    await settle();
    expect(open).toHaveBeenCalledTimes(1);
    expect(toast.add).not.toHaveBeenCalled();
  });

  it("opens once when a second window claims after the first recorded its opening", async () => {
    const id = await startWithLostReply();
    const second = await openSecondWindow();
    observe(operation({ signInRequestId: id }));
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    second.observe(operation({ signInRequestId: id }));
    await settle();
    expect(open).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["Web Locks are unavailable", () => vi.stubGlobal("navigator", {})],
    [
      "local storage throws",
      () =>
        vi.spyOn(shared, "setItem").mockImplementation(() => {
          throw new Error("QuotaExceededError");
        }),
    ],
  ])("never opens automatically when %s, and offers the page instead", async (_name, arrange) => {
    arrange();
    await start(async (id) => operation({ signInRequestId: id }));
    expect(open).not.toHaveBeenCalled();
    expect(toast.add).toHaveBeenCalledTimes(1);
    const notice = toast.add.mock.calls[0]![0] as {
      readonly title: string;
      readonly actionProps: { readonly children: string; readonly onClick: () => void };
    };
    expect(notice.title).toBe("Open the Antigravity sign-in page");
    notice.actionProps.onClick();
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(1));
  });

  it("treats a blocked popup as failed and offers the user's own click", async () => {
    resetProviderSignInBrowserForTests({ now: () => clock });
    windowOpen.mockReturnValue(null);
    await start(async (id) => operation({ signInRequestId: id }));
    expect(windowOpen).toHaveBeenCalledWith("about:blank", "_blank", "popup");
    expect(toast.add).toHaveBeenCalledTimes(1);
    const notice = toast.add.mock.calls[0]![0] as {
      readonly type: string;
      readonly title: string;
      readonly description: string;
      readonly actionProps: { readonly children: string; readonly onClick: () => void };
    };
    expect(notice).toMatchObject({
      type: "warning",
      title: "The Antigravity sign-in page was blocked",
      description: "Your browser blocked the sign-in page. Open it to continue.",
    });
    expect(notice.description).not.toContain("could not open");

    // The toast's button is a click, so the browser lets that open through.
    const link = { href: "", rel: "", click: vi.fn() };
    const opened = {
      closed: false,
      opener: {} as unknown,
      document: { createElement: () => link, body: { append: vi.fn() } },
    };
    windowOpen.mockReturnValue(opened);
    notice.actionProps.onClick();
    await vi.waitFor(() => expect(link.click).toHaveBeenCalledTimes(1));
    expect(opened.opener).toBeNull();
    expect(link).toMatchObject({ href: url, rel: "noreferrer" });
  });

  it("reports an opening failure as a toast with a retry when no setup view shows it", async () => {
    open.mockRejectedValueOnce(new Error("Unable to open /private/profile?code=private-code"));
    await start(async (id) => operation({ signInRequestId: id }));
    expect(toast.add).toHaveBeenCalledTimes(1);
    const notice = toast.add.mock.calls[0]![0] as {
      readonly title: string;
      readonly description: string;
      readonly actionProps: { readonly children: string; readonly onClick: () => void };
    };
    expect(notice.title).toBe("Couldn’t open the Antigravity sign-in page");
    expect(notice.description).not.toContain("private");
    expect(notice.actionProps.children).toBe("Open sign-in page");
    notice.actionProps.onClick();
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(2));
  });
});
