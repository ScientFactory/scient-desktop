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
  type ProviderSignInPageClaimer,
  resetProviderSignInBrowserForTests,
  setProviderSignInPageClaimer,
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

const open = vi.fn<(url: string) => Promise<void>>();
let storage: MemoryStorage;
const windowOpen = vi.fn<(url: string, target: string, features: string) => unknown>();

let clock = 0;
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * The server's claim, as the connection manager grants it: once per operation,
 * to the request id stamped on it. `failures` answers with transport errors first.
 */
function makeServer() {
  const granted = new Set<string>();
  let failures = 0;
  const claim = vi.fn<ProviderSignInPageClaimer>(async (_environmentId, input) => {
    if (failures > 0) {
      failures -= 1;
      throw new Error("The environment connection closed.");
    }
    if (granted.has(input.operationId)) return false;
    granted.add(input.operationId);
    return true;
  });
  return { claim, failNext: (count: number) => (failures = count) };
}
let server = makeServer();

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

/** A renderer reload, or another window that starts with a copy of this session. */
function reloadWith(session: MemoryStorage) {
  vi.stubGlobal("window", { sessionStorage: session, open: windowOpen });
  resetProviderSignInBrowserForTests({ open, now: () => clock, reload: true, claim: server.claim });
}

beforeEach(() => {
  vi.resetAllMocks();
  open.mockResolvedValue(undefined);
  storage = new MemoryStorage();
  windowOpen.mockReset();
  vi.stubGlobal("window", { sessionStorage: storage, open: windowOpen });
  clock = Date.now();
  server = makeServer();
  resetProviderSignInBrowserForTests({ open, now: () => clock, claim: server.claim });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("provider sign-in page opening", () => {
  it("opens the page of an operation this client started, once the server grants it", async () => {
    await start(async (id) => operation({ signInRequestId: id }));
    expect(server.claim).toHaveBeenCalledTimes(1);
    expect(server.claim.mock.calls[0]![1]).toMatchObject({
      instanceId,
      operationId: "connect-1",
    });
    expect(open.mock.calls).toEqual([[url]]);
    expect(storage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("opens from the stream when the start reply is lost, once", async () => {
    const id = await startWithLostReply();
    const { authorizationUrl: _url, ...starting } = operation({
      status: "starting",
      signInRequestId: id,
    });
    observe(starting);
    await settle();
    expect(server.claim).not.toHaveBeenCalled();

    observe(operation({ signInRequestId: id }));
    observe(operation({ signInRequestId: id }));
    await settle();
    expect(open.mock.calls).toEqual([[url]]);
    expect(server.claim).toHaveBeenCalledTimes(1);
  });

  it("opens once after a reload before any claim", async () => {
    const id = await startWithLostReply();
    reloadWith(storage);
    observe(operation({ signInRequestId: id }));
    await settle();
    expect(open).toHaveBeenCalledTimes(1);
    reloadWith(storage);
    observe(operation({ signInRequestId: id }));
    await settle();
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("does not open again after a reload whose session still holds an id already granted", async () => {
    const id = await startWithLostReply();
    // A copy of the session from before the grant: a crash, or a copied window.
    const before = storage.clone();
    observe(operation({ signInRequestId: id }));
    await settle();
    expect(open).toHaveBeenCalledTimes(1);

    reloadWith(before);
    observe(operation({ signInRequestId: id }));
    await settle();
    expect(open).toHaveBeenCalledTimes(1);
    expect(before.getItem(STORAGE_KEY)).toBeNull();
    expect(toast.add).not.toHaveBeenCalled();
  });

  it("opens once across two windows sharing a copied session", async () => {
    const id = await startWithLostReply();
    const copied = storage.clone();
    vi.resetModules();
    vi.stubGlobal("window", { sessionStorage: copied, open: windowOpen });
    const second = await import("./providerSignInBrowser");
    expect(second.observeProviderSignInSnapshots).not.toBe(observeProviderSignInSnapshots);
    second.resetProviderSignInBrowserForTests({
      open,
      now: () => clock,
      reload: true,
      claim: server.claim,
    });
    second.observeProviderSignInSnapshots(environmentId, [
      provider(operation({ signInRequestId: id })),
    ]);
    vi.stubGlobal("window", { sessionStorage: storage, open: windowOpen });
    observe(operation({ signInRequestId: id }));
    await settle();
    await settle();
    expect(server.claim).toHaveBeenCalledTimes(2);
    expect(open).toHaveBeenCalledTimes(1);
    expect(toast.add).not.toHaveBeenCalled();
  });

  it("never claims or opens another client's sign-in", async () => {
    await startWithLostReply();
    observe(operation({ signInRequestId: "another-client-request" }));
    observe(operation());
    await settle();
    expect(server.claim).not.toHaveBeenCalled();
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

  it.each(["cancelled", "failed", "connected"] as const)(
    "releases the id of an operation %s, by reply or snapshot, opening and offering nothing",
    async (status) => {
      await start(async (id) => operation({ status, signInRequestId: id }));
      const id = await startWithLostReply();
      observe(operation({ status, signInRequestId: id }));
      await settle();
      expect(server.claim).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();
      expect(toast.add).not.toHaveBeenCalled();
      expect(storage.getItem(STORAGE_KEY)).toBeNull();
    },
  );

  it("releases a denied id silently", async () => {
    const id = await startWithLostReply();
    server.claim.mockResolvedValueOnce(false);
    observe(operation({ signInRequestId: id }));
    await settle();
    expect(open).not.toHaveBeenCalled();
    expect(toast.add).not.toHaveBeenCalled();
    expect(storage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("keeps the id after an unknown claim outcome and asks again on the next snapshot", async () => {
    const id = await startWithLostReply();
    server.failNext(1);
    observe(operation({ signInRequestId: id }));
    await settle();
    expect(open).not.toHaveBeenCalled();
    expect(storage.getItem(STORAGE_KEY)).toContain(id);

    observe(operation({ signInRequestId: id }));
    await settle();
    expect(server.claim).toHaveBeenCalledTimes(2);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("claims the operations it already saw once the claim command arrives", async () => {
    resetProviderSignInBrowserForTests({ open, now: () => clock, claim: null });
    const id = await startWithLostReply();
    observe(operation({ signInRequestId: id }));
    await settle();
    expect(open).not.toHaveBeenCalled();
    // No further snapshot: registering the command replays what was seen.
    setProviderSignInPageClaimer(server.claim);
    await settle();
    expect(server.claim).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledTimes(1);
    setProviderSignInPageClaimer(server.claim);
    await settle();
    expect(open).toHaveBeenCalledTimes(1);
  });

  it.each(["cancelled", "failed", "connected"] as const)(
    "does not open a page granted after its operation was %s",
    async (status) => {
      let grant!: (granted: boolean) => void;
      server.claim.mockImplementationOnce(
        () => new Promise<boolean>((resolve) => (grant = resolve)),
      );
      const id = await startWithLostReply();
      observe(operation({ signInRequestId: id }));
      await settle();
      expect(server.claim).toHaveBeenCalledTimes(1);

      // The operation ends while the claim is still being answered.
      observe(operation({ status, signInRequestId: id }));
      grant(true);
      await settle();
      expect(open).not.toHaveBeenCalled();
      expect(toast.add).not.toHaveBeenCalled();
      expect(storage.getItem(STORAGE_KEY)).toBeNull();
    },
  );

  it("does not open a page granted after its operation was replaced", async () => {
    let grant!: (granted: boolean) => void;
    server.claim.mockImplementationOnce(() => new Promise<boolean>((resolve) => (grant = resolve)));
    const id = await startWithLostReply();
    observe(operation({ signInRequestId: id }));
    await settle();
    observe(operation({ operationId: "connect-2", signInRequestId: "another-client-request" }));
    grant(true);
    await settle();
    expect(open).not.toHaveBeenCalled();
  });

  it("does not let a delayed start reply revive an operation a snapshot replaced", async () => {
    let grant!: (granted: boolean) => void;
    server.claim.mockImplementationOnce(() => new Promise<boolean>((resolve) => (grant = resolve)));
    let id!: string;
    let reply!: (operation: ProviderConnectionOperation) => void;
    const started = start((requestId) => {
      id = requestId;
      return new Promise((resolve) => (reply = resolve));
    });
    observe(operation({ signInRequestId: id }));
    await settle();
    expect(server.claim).toHaveBeenCalledTimes(1);

    observe(operation({ operationId: "connect-2", signInRequestId: "another-client-request" }));
    reply(operation({ signInRequestId: id }));
    await started;
    grant(true);
    await settle();
    expect(open).not.toHaveBeenCalled();
    expect(toast.add).not.toHaveBeenCalled();
    expect(server.claim).toHaveBeenCalledTimes(1);
    expect(storage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("lets a start reply seed the operation while no snapshot has shown the instance", async () => {
    let grant!: (granted: boolean) => void;
    server.claim.mockImplementationOnce(() => new Promise<boolean>((resolve) => (grant = resolve)));
    const started = start(async (id) => operation({ signInRequestId: id }));
    await settle();
    expect(server.claim).toHaveBeenCalledTimes(1);
    grant(true);
    await started;
    expect(open.mock.calls).toEqual([[url]]);
  });

  it("waits for the snapshot that shows a reply's operation once snapshots have arrived", async () => {
    observe(operation({ operationId: "connect-0", status: "failed" }));
    let id!: string;
    await start(async (requestId) => {
      id = requestId;
      return operation({ signInRequestId: requestId });
    });
    expect(server.claim).not.toHaveBeenCalled();
    expect(storage.getItem(STORAGE_KEY)).toContain(id);

    observe(operation({ signInRequestId: id }));
    await settle();
    expect(server.claim).toHaveBeenCalledTimes(1);
    expect(open.mock.calls).toEqual([[url]]);
  });

  it("releases a held id once a snapshot no longer shows the operation it was stamped on", async () => {
    const id = await startWithLostReply();
    const { authorizationUrl: _url, ...starting } = operation({
      status: "starting",
      signInRequestId: id,
    });
    observe(starting);
    expect(storage.getItem(STORAGE_KEY)).toContain(id);
    observe(operation({ operationId: "connect-2", signInRequestId: "another-client-request" }));
    await settle();
    expect(storage.getItem(STORAGE_KEY)).toBeNull();
    expect(server.claim).not.toHaveBeenCalled();
  });

  it("drops ids of expired operations", async () => {
    const id = await startWithLostReply();
    clock += 16 * 60_000;
    observe(operation({ signInRequestId: id }));
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

  it("does not claim what must not open", async () => {
    for (const current of [
      operation({ authorizationUrlKind: "manual_fallback" }),
      operation({ status: "verifying" }),
    ]) {
      await start(async (id) => ({ ...current, signInRequestId: id }));
    }
    expect(server.claim).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it("uses the reply alone with a server that does not stamp request ids", async () => {
    await start(async () => operation(), "connect-1");
    expect(open).not.toHaveBeenCalled();
    await start(async () => operation());
    await start(async () => operation());
    expect(server.claim).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledTimes(1);
    expect(storage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("closes the blank window when navigating it fails, and offers the page again", async () => {
    resetProviderSignInBrowserForTests({ now: () => clock, claim: server.claim });
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
    expect(notice.title).toBe("Antigravity sign-in page didn’t open");
    expect(notice.actionProps.children).toBe("Open");
  });
  it("treats a blocked popup as failed and offers the user's own click", async () => {
    resetProviderSignInBrowserForTests({ now: () => clock, claim: server.claim });
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
    expect(notice).toMatchObject({ type: "warning", title: "Antigravity sign-in page blocked" });
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
    expect(notice.title).toBe("Antigravity sign-in page didn’t open");
    expect(notice.description).toBeUndefined();
    expect(notice.actionProps.children).toBe("Open");
    notice.actionProps.onClick();
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(2));
  });
});
