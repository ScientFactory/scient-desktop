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
  openProviderSignInPageByHand,
  type ProviderSignInPageClaimer,
  resetProviderSignInForTests,
  setProviderSignInPageClaimer,
  startProviderSignIn,
} from "./providerSignInFlow";

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

function provider(current: ProviderConnectionOperation | null): ServerProvider {
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

let clock = 0;
const settle = () => vi.runAllTimersAsync();

/**
 * The server, as the connection manager runs it: `current` is its operation for
 * the instance, which the client's replies and snapshots may lag behind. The
 * claim is granted once per operation, to the request id stamped on the current
 * operation while it waits on a primary page, with that page's URL. `failures`
 * answers with transport errors first; `hold` defers the next answer until the
 * test releases it, and decides it then.
 */
function makeServer() {
  const granted = new Set<string>();
  let failures = 0;
  let held: (() => void) | null = null;
  const state = { current: null as ProviderConnectionOperation | null };
  const decide = (input: Parameters<ProviderSignInPageClaimer>[1]) => {
    const current = state.current;
    if (
      current === null ||
      current.operationId !== input.operationId ||
      current.signInRequestId !== input.signInRequestId ||
      current.status !== "waiting_for_browser" ||
      current.authorizationUrlKind !== "primary" ||
      current.authorizationUrl === undefined ||
      granted.has(input.operationId)
    ) {
      return { granted: false as const };
    }
    granted.add(input.operationId);
    return { granted: true as const, authorizationUrl: current.authorizationUrl };
  };
  let holdNext = false;
  const claim = vi.fn<ProviderSignInPageClaimer>(async (_environmentId, input) => {
    if (failures > 0) {
      failures -= 1;
      throw new Error("The environment connection closed.");
    }
    if (!holdNext) return decide(input);
    holdNext = false;
    await new Promise<void>((resolve) => (held = resolve));
    return decide(input);
  });
  return {
    claim,
    state,
    failNext: (count: number) => (failures = count),
    /** Defers the next claim's answer; the returned function lets the server decide it. */
    hold: () => {
      holdNext = true;
      return async () => {
        held!();
        await settle();
      };
    },
  };
}
let server = makeServer();

/** The server's operation changes, and a reply now would say so. */
const serve = (current: ProviderConnectionOperation | null) => {
  server.state.current = current;
  return current;
};

/**
 * Starts a sign-in whose server stamps the request id on the operation it
 * returns; the operation the reply shows is the server's when it answers.
 */
function start(
  reply: (signInRequestId: string) => Promise<ProviderConnectionOperation | null>,
  previousOperationId: string | null = null,
) {
  return startProviderSignIn({
    key,
    providerName: "Antigravity",
    previousOperationId,
    start: async (id) => serve(await reply(id)),
    operationOf: (value) => value,
  });
}

/** A start whose reply never arrives; resolves with the id the server received. */
function startWithLostReply() {
  return new Promise<string>((received) => {
    void startProviderSignIn({
      key,
      providerName: "Antigravity",
      previousOperationId: null,
      start: (signInRequestId) => {
        received(signInRequestId);
        return new Promise<never>(() => undefined);
      },
      operationOf: () => null,
    });
  });
}

/** A snapshot that shows the server's operation as it is now. */
const observe = (current: ProviderConnectionOperation) => {
  serve(current);
  observeLagging(current);
};

/** A snapshot from before the server's latest change. */
const observeLagging = (current: ProviderConnectionOperation | null) =>
  observeProviderSignInSnapshots(environmentId, [provider(current)]);

/** A renderer reload, or another window that starts with a copy of this session. */
function reloadWith(session: MemoryStorage) {
  vi.stubGlobal("window", { sessionStorage: session });
  resetProviderSignInForTests({ open, now: () => clock, reload: true, claim: server.claim });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  open.mockResolvedValue(undefined);
  storage = new MemoryStorage();
  vi.stubGlobal("window", { sessionStorage: storage });
  clock = Date.parse("2026-10-20T12:00:00.000Z");
  vi.setSystemTime(clock);
  server = makeServer();
  resetProviderSignInForTests({ open, now: () => clock, claim: server.claim });
});

afterEach(() => {
  vi.useRealTimers();
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

  it("opens the page the grant names", async () => {
    const current = "https://accounts.google.com/o/oauth2/v2/auth?client_id=synthetic-current";
    const id = await startWithLostReply();
    serve(operation({ signInRequestId: id, authorizationUrl: current }));
    observeLagging(operation({ signInRequestId: id }));
    await settle();
    expect(open.mock.calls).toEqual([[current]]);
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

  it("opens once when snapshots lag behind the start reply", async () => {
    observe(operation({ operationId: "connect-0", status: "failed" }));
    let id!: string;
    await start(async (requestId) => {
      id = requestId;
      return operation({ signInRequestId: requestId });
    });
    observeLagging(operation({ operationId: "connect-0", status: "failed" }));
    observeLagging(null);
    observeLagging(operation({ signInRequestId: id }));
    await settle();
    expect(server.claim).toHaveBeenCalledTimes(1);
    expect(open.mock.calls).toEqual([[url]]);
    expect(toast.add).not.toHaveBeenCalled();
    expect(storage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("keeps a pending grant through a lagging snapshot, and opens once", async () => {
    observe(operation({ operationId: "connect-0", status: "failed" }));
    const answer = server.hold();
    let id!: string;
    const started = start(async (requestId) => {
      id = requestId;
      return operation({ signInRequestId: requestId });
    });
    await settle();
    expect(server.claim).toHaveBeenCalledTimes(1);
    observeLagging(operation({ operationId: "connect-0", status: "failed" }));
    await answer();
    await started;
    observeLagging(operation({ signInRequestId: id }));
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
    vi.stubGlobal("window", { sessionStorage: copied });
    const second = await import("./providerSignInFlow");
    expect(second.observeProviderSignInSnapshots).not.toBe(observeProviderSignInSnapshots);
    second.resetProviderSignInForTests({
      open,
      now: () => clock,
      reload: true,
      claim: server.claim,
    });
    serve(operation({ signInRequestId: id }));
    second.observeProviderSignInSnapshots(environmentId, [
      provider(operation({ signInRequestId: id })),
    ]);
    vi.stubGlobal("window", { sessionStorage: storage });
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
    let answer!: (value: ProviderConnectionOperation) => void;
    const reply = new Promise<ProviderConnectionOperation>((resolve) => {
      answer = resolve;
    });
    // As the command's single flight does: the second caller shares the first reply.
    const started = Promise.all([
      start((id) => {
        first = id;
        return reply;
      }),
      start(() => reply),
    ]);
    answer(operation({ signInRequestId: first! }));
    await started;
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
    server.claim.mockResolvedValueOnce({ granted: false });
    observe(operation({ signInRequestId: id }));
    await settle();
    expect(open).not.toHaveBeenCalled();
    expect(toast.add).not.toHaveBeenCalled();
    expect(storage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("is denied, silently, when the server cancelled before the claim", async () => {
    const id = await startWithLostReply();
    serve(operation({ status: "cancelled", signInRequestId: id }));
    observeLagging(operation({ signInRequestId: id }));
    await settle();
    expect(server.claim).toHaveBeenCalledTimes(1);
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

  it("keeps the id while the claim command is missing, and claims on the next report", async () => {
    resetProviderSignInForTests({ open, now: () => clock, claim: null });
    const id = await startWithLostReply();
    observe(operation({ signInRequestId: id }));
    await settle();
    expect(storage.getItem(STORAGE_KEY)).toContain(id);
    setProviderSignInPageClaimer(server.claim);
    observe(operation({ signInRequestId: id }));
    await settle();
    expect(server.claim).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it.each(["cancelled", "failed", "connected"] as const)(
    "does not open a page granted when a snapshot shows its operation %s first",
    async (status) => {
      const answer = server.hold();
      const id = await startWithLostReply();
      observe(operation({ signInRequestId: id }));
      await settle();
      expect(server.claim).toHaveBeenCalledTimes(1);

      // The server granted the claim, then the operation ended; the snapshot
      // saying so arrives before the grant does.
      const current = server.state.current;
      observe(operation({ status, signInRequestId: id }));
      serve(current);
      await answer();
      expect(open).not.toHaveBeenCalled();
      expect(toast.add).not.toHaveBeenCalled();
      expect(storage.getItem(STORAGE_KEY)).toBeNull();
    },
  );

  it("opens nothing for an operation replaced before its delayed claim and reply", async () => {
    const answer = server.hold();
    let id!: string;
    let reply!: (operation: ProviderConnectionOperation) => void;
    const started = startProviderSignIn({
      key,
      providerName: "Antigravity",
      previousOperationId: null,
      start: (requestId) => {
        id = requestId;
        return new Promise<ProviderConnectionOperation>((resolve) => (reply = resolve));
      },
      operationOf: (value) => value,
    });
    observe(operation({ signInRequestId: id }));
    await settle();
    expect(server.claim).toHaveBeenCalledTimes(1);

    observe(operation({ operationId: "connect-2", signInRequestId: "another-client-request" }));
    reply(operation({ signInRequestId: id }));
    await started;
    await answer();
    expect(server.claim).toHaveBeenCalledTimes(1);
    expect(open).not.toHaveBeenCalled();
    expect(toast.add).not.toHaveBeenCalled();
    expect(storage.getItem(STORAGE_KEY)).toBeNull();
  });

  it.each([
    ["spends the held id", true],
    ["is already open, even with the id still held", false],
  ] as const)(
    "opens once when the user opens the page during a pending claim: the opening %s",
    async (_case, withId) => {
      const answer = server.hold();
      const id = await startWithLostReply();
      observe(operation({ signInRequestId: id }));
      await settle();
      expect(server.claim).toHaveBeenCalledTimes(1);

      await openProviderSignInPageByHand({
        key,
        operationId: "connect-1",
        signInRequestId: withId ? id : undefined,
        url,
        providerName: "Antigravity",
      });
      expect(open).toHaveBeenCalledTimes(1);
      // A manual opening that names the id spends it at once.
      expect(storage.getItem(STORAGE_KEY) === null).toBe(withId);
      await answer();
      expect(open).toHaveBeenCalledTimes(1);
      expect(toast.add).not.toHaveBeenCalled();
      expect(storage.getItem(STORAGE_KEY)).toBeNull();
    },
  );

  it("releases a restored id without claiming when its page was opened here by hand", async () => {
    const id = await startWithLostReply();
    reloadWith(storage);
    await openProviderSignInPageByHand({
      key,
      operationId: "connect-1",
      signInRequestId: undefined,
      url,
      providerName: "Antigravity",
    });
    server.failNext(1);
    observe(operation({ signInRequestId: id }));
    await settle();
    expect(server.claim).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledTimes(1);
    expect(storage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("releases a restored id without claiming when an unstamped reply opened its page", async () => {
    const id = await startWithLostReply();
    reloadWith(storage);
    await start(async () => operation());
    expect(open).toHaveBeenCalledTimes(1);
    server.failNext(1);
    observe(operation({ signInRequestId: id }));
    await settle();
    expect(server.claim).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledTimes(1);
    expect(storage.getItem(STORAGE_KEY)).toBeNull();
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
});
