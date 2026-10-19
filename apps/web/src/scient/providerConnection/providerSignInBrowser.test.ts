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
  // The real Web Locks, as every window of one browser shares them.
  vi.stubGlobal("navigator", { locks: realLocks });
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

  /** Starts a sign-in whose second window takes the claim first and pauses inside it. */
  async function claimHeldBySecondWindow() {
    const id = await startWithLostReply();
    let release!: (outcome: "record" | "abandon") => void;
    let paused!: () => void;
    const inside = new Promise<void>((resolve) => (paused = resolve));
    const second = await openSecondWindow({
      beforeClaimRecord: () =>
        new Promise<void>((resolve, reject) => {
          release = (outcome) =>
            outcome === "record" ? resolve() : reject(new Error("The window closed."));
          paused();
        }),
    });
    second.observe(operation({ signInRequestId: id }));
    await inside;
    return { id, release };
  }

  it("opens once when the window holding the claim gives it up before opening", async () => {
    const { id, release } = await claimHeldBySecondWindow();
    observe(operation({ signInRequestId: id }));
    await settle();
    expect(open).not.toHaveBeenCalled();

    // Its lock goes with it, as when its page closes; the record says nobody opened.
    release("abandon");
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    observe(operation({ signInRequestId: id }));
    await settle();
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("does nothing, and shows nothing, when the holding window opens the page", async () => {
    const { id, release } = await claimHeldBySecondWindow();
    observe(operation({ signInRequestId: id }));
    await settle();
    release("record");
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    await settle();
    expect(open).toHaveBeenCalledTimes(1);
    expect(toast.add).not.toHaveBeenCalled();
    expect(storage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("offers the page when waiting for another window's claim runs out", async () => {
    const { id, release } = await claimHeldBySecondWindow();
    // The id is about to expire: the wait ends without the lock.
    clock += 15 * 60_000 - 50;
    observe(operation({ signInRequestId: id }));
    await vi.waitFor(() => expect(toast.add).toHaveBeenCalledTimes(1));
    expect(open).not.toHaveBeenCalled();
    expect((toast.add.mock.calls[0]![0] as { readonly title: string }).title).toBe(
      "Open the sign-in page to continue",
    );
    release("record");
    await settle();
  });

  /** Another window holds the claim lock for operation "connect-1" until released. */
  async function holdClaimLockElsewhere() {
    const name = `scient.providerSignIn.opened.v1:${environmentId} ${instanceId} connect-1`;
    let release!: () => void;
    let granted!: () => void;
    const held = new Promise<void>((resolve) => (granted = resolve));
    void realLocks.request(name, () => {
      granted();
      return new Promise<void>((resolve) => (release = resolve));
    });
    await held;
    const pendingRequests = async () =>
      ((await realLocks.query()).pending ?? []).filter((lock) => lock.name === name).length;
    return { release: () => release(), pendingRequests };
  }

  it.each([
    ["cancelled", operation({ status: "cancelled" })],
    ["failed", operation({ status: "failed" })],
    ["connected", operation({ status: "connected" })],
    // Another start's operation replaces this one.
    [
      "superseded",
      operation({ operationId: "connect-2", signInRequestId: "another-client-request" }),
    ],
  ])(
    "withdraws a waiting claim whose operation is %s, opening and offering nothing",
    async (_name, next) => {
      const id = await startWithLostReply();
      const holder = await holdClaimLockElsewhere();
      observe(operation({ signInRequestId: id }));
      await vi.waitFor(async () => expect(await holder.pendingRequests()).toBe(1));

      observe(next.signInRequestId ? next : { ...next, signInRequestId: id });
      await settle();
      // Node lists a withdrawn request until the lock is released; Chromium drops it at once.
      holder.release();
      await settle();
      await settle();
      expect(await holder.pendingRequests()).toBe(0);
      expect(open).not.toHaveBeenCalled();
      expect(toast.add).not.toHaveBeenCalled();
    },
  );

  it("withdraws a waiting claim when its provider leaves the snapshot", async () => {
    const id = await startWithLostReply();
    const holder = await holdClaimLockElsewhere();
    observe(operation({ signInRequestId: id }));
    await vi.waitFor(async () => expect(await holder.pendingRequests()).toBe(1));
    observeProviderSignInSnapshots(environmentId, []);
    await settle();
    holder.release();
    await settle();
    await settle();
    expect(await holder.pendingRequests()).toBe(0);
    expect(open).not.toHaveBeenCalled();
    expect(toast.add).not.toHaveBeenCalled();
  });

  it("re-reads the operation once the lock is held, and opens only if it still waits", async () => {
    const id = await startWithLostReply();
    const holder = await holdClaimLockElsewhere();
    observe(operation({ signInRequestId: id }));
    await vi.waitFor(async () => expect(await holder.pendingRequests()).toBe(1));
    // A lagging snapshot still says "starting": the claim waits on, then opens.
    const { authorizationUrl: _url, ...starting } = operation({
      status: "starting",
      signInRequestId: id,
    });
    observe(starting);
    expect(await holder.pendingRequests()).toBe(1);
    observe(operation({ signInRequestId: id }));
    holder.release();
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(1));
  });

  it("opens once after a reload while another window holds the claim, if it still waits", async () => {
    const id = await startWithLostReply();
    const holder = await holdClaimLockElsewhere();
    resetProviderSignInBrowserForTests({ open, now: () => clock, reload: true });
    observe(operation({ signInRequestId: id }));
    observe(operation({ signInRequestId: id }));
    await vi.waitFor(async () => expect(await holder.pendingRequests()).toBe(1));
    // The holder closes without recording an opening.
    holder.release();
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(1));
    observe(operation({ signInRequestId: id }));
    await settle();
    expect(open).toHaveBeenCalledTimes(1);
    expect(toast.add).not.toHaveBeenCalled();
  });

  it("closes the blank window when navigating it fails, and offers the page again", async () => {
    resetProviderSignInBrowserForTests({ now: () => clock });
    const opened = {
      closed: false,
      opener: {} as unknown,
      close: vi.fn(),
      document: {
        createElement: () => {
          throw new Error("Navigation refused.");
        },
      },
    };
    windowOpen.mockReturnValue(opened);
    await start(async (id) => operation({ signInRequestId: id }));
    expect(opened.close).toHaveBeenCalledTimes(1);
    expect(toast.add).toHaveBeenCalledTimes(1);
    const notice = toast.add.mock.calls[0]![0] as {
      readonly title: string;
      readonly actionProps: { readonly children: string };
    };
    expect(notice.title).toBe("Couldn’t open the sign-in page");
    expect(notice.actionProps.children).toBe("Open");
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
    expect(notice.title).toBe("Open the sign-in page to continue");
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
    expect(notice).toMatchObject({ type: "warning", title: "Sign-in page blocked" });
    expect(notice.description).toBeUndefined();
    expect(notice.actionProps.children).toBe("Open");

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
    expect(notice.title).toBe("Couldn’t open the sign-in page");
    expect(notice.description).toBeUndefined();
    expect(notice.actionProps.children).toBe("Open");
    notice.actionProps.onClick();
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(2));
  });
});
