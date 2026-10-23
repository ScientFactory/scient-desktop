import { act as _fixtureAct, render as _fixtureRender, type Screen } from "../../../test/render";
import "../../index.css";

import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderConnectionOperation,
  type ServerProvider,
} from "@t3tools/contracts";

import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vitest/browser";

import { toastManager } from "../../components/ui/toast";
import { AntigravityInlineSetup } from "./AntigravityInlineSetup";
import {
  observeProviderSignInSnapshots,
  resetProviderSignInForTests,
  startProviderSignIn,
} from "./providerSignInFlow";
import { navigateWithoutReferrer } from "./providerSignInPage";
import type { ProviderLifecycleController } from "./useProviderLifecycleController";

const INSTANCE_ID = ProviderInstanceId.make("antigravity");
const PRIVATE_BROWSER_FAILURE = new Error(
  "Unable to open /private/provider/profile https://accounts.google.com/?code=private-code",
);
const AUTHORIZATION_URL = "https://accounts.google.com/o/oauth2/v2/auth?client_id=synthetic-test";
const signInKey = {
  environmentId: EnvironmentId.make("environment-test"),
  instanceId: INSTANCE_ID,
};

// The server's answer to this client's start command; it stamps the request id it received.

/** The server's claim: granted once per operation, with the page to open. */
function grantOncePerOperation() {
  const granted = new Set<string>();
  return async (_environmentId: unknown, input: { readonly operationId: string }) => {
    if (granted.has(input.operationId)) return { granted: false as const };
    granted.add(input.operationId);
    return { granted: true as const, authorizationUrl: AUTHORIZATION_URL };
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function operation(patch: Partial<ProviderConnectionOperation> = {}): ProviderConnectionOperation {
  return {
    operationId: "auth-1",
    method: "antigravity_google",
    status: "waiting_for_browser",
    startedAt: "2026-10-11T00:00:00.000Z",
    finishedAt: null,
    message: "Finish signing in.",
    authorizationUrl: AUTHORIZATION_URL,
    authorizationUrlKind: "primary",
    acceptsAuthorizationCode: true,
    authorizationResponseKind: "callback_url",
    ...patch,
  };
}

/** An operation created by this client's start request. */
function mine(
  _fixture: _Fixture,
  patch: Partial<ProviderConnectionOperation> = {},
): ProviderConnectionOperation {
  return operation({
    ...patch,
    ...(_fixture.requestId ? { signInRequestId: _fixture.requestId } : {}),
  });
}

function starting(_fixture: _Fixture): ProviderConnectionOperation {
  const {
    authorizationUrl: _url,
    authorizationUrlKind: _kind,
    ...value
  } = mine(_fixture, { status: "starting", message: "Starting Antigravity." });
  return value;
}

function snapshot(current: ProviderConnectionOperation | null = null): ServerProvider {
  return {
    instanceId: INSTANCE_ID,
    driver: ProviderDriverKind.make("antigravity"),
    enabled: true,
    installed: true,
    version: "1.1.17",
    status: "warning",
    auth: { status: "unauthenticated", required: true },
    checkedAt: "2026-10-11T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    connection: {
      methods: ["antigravity_google"],
      canDisconnect: false,
      operation: current,
      // As the server publishes it, so the card can say so from the click.
      startingMessage: "Antigravity can take up to a minute to start.",
    },
  };
}

async function renderProvider(_fixture: _Fixture, provider: ServerProvider) {
  _fixture.latest = provider;
  if (!_fixture.host) {
    _fixture.host = document.createElement("div");
    document.body.append(_fixture.host);
    _fixture.root0 = _fixture.stack.use(
      await _fixtureRender(null, { container: _fixture.host, router: false }),
    );
  }
  await _fixtureAct(async () => {
    await _fixture.root0!.rerender(
      <AntigravityInlineSetup
        controller={_fixture.controller}
        displayName="Antigravity"
        provider={provider}
      />,
    );
  });
}

/** The setup popover closing, while the server keeps the sign-in. */
async function closeView(_fixture: _Fixture, provider: ServerProvider) {
  _fixture.latest = provider;
  await _fixtureAct(async () => await _fixture.root0!.rerender(null));
}

const text = (_fixture: _Fixture) => _fixture.host!.textContent ?? "";

async function _setupFixture0(_fixture: _Fixture) {
  vi.resetAllMocks();
  _fixture.latest = snapshot();
  _fixture.requestId = undefined;
  _fixture.openPage.mockResolvedValue(undefined);
  _fixture.claim = grantOncePerOperation();
  resetProviderSignInForTests({ open: _fixture.openPage, claim: _fixture.claim });
  _fixture.serverStart.mockImplementation(async () => snapshot(mine(_fixture)));
  _fixture.controller.cancelConnection.mockResolvedValue(snapshot());
  _fixture.controller.submitAuthorizationCode.mockResolvedValue(snapshot());
}

async function _cleanupFixture1(_fixture: _Fixture) {
  await _fixture.root0?.unmount();
  _fixture.host?.remove();
  resetProviderSignInForTests();
  _fixture.root0 = undefined;
  _fixture.host = undefined;
}

describe("Antigravity sign-in page", () => {
  it("opens once for this client even when the setup view closes during a slow start", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const start = deferred<ServerProvider>();
    _fixture.serverStart.mockReturnValue(start.promise);
    using toastAdd = vi.spyOn(toastManager, "add");
    await renderProvider(_fixture, snapshot());

    await page.getByRole("button", { name: "Sign in with Google" }).click();
    await renderProvider(_fixture, snapshot(starting(_fixture)));
    await expect.element(page.getByText("Starting Google sign-in")).toBeVisible();
    expect(text(_fixture)).toContain("Antigravity can take up to a minute to start.");

    await closeView(_fixture, snapshot(starting(_fixture)));
    start.resolve(snapshot(mine(_fixture)));
    await vi.waitFor(() => expect(_fixture.openPage.mock.calls).toEqual([[AUTHORIZATION_URL]]));

    // Back in the view, and through reconnects that redeliver the same snapshot.
    await renderProvider(_fixture, snapshot(mine(_fixture)));
    await renderProvider(_fixture, snapshot(mine(_fixture)));
    await expect
      .element(page.getByText("Complete the official Antigravity sign-in in your browser."))
      .toBeVisible();
    await closeView(_fixture, snapshot(mine(_fixture)));
    await renderProvider(_fixture, snapshot(mine(_fixture)));
    await expect.element(page.getByRole("button", { name: "Reopen Google sign-in" })).toBeEnabled();
    expect(_fixture.openPage).toHaveBeenCalledTimes(1);
    expect(toastAdd).not.toHaveBeenCalled();
  });

  it("opens once from the stream when the start reply is lost and the view has closed", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    _fixture.serverStart.mockReturnValue(new Promise<never>(() => undefined));
    await renderProvider(_fixture, snapshot());
    await page.getByRole("button", { name: "Sign in with Google" }).click();
    await closeView(_fixture, snapshot(starting(_fixture)));

    // What the app-level coordinator feeds from the provider stream.
    observeProviderSignInSnapshots(signInKey.environmentId, [snapshot(mine(_fixture))]);
    observeProviderSignInSnapshots(signInKey.environmentId, [snapshot(mine(_fixture))]);
    await vi.waitFor(() => expect(_fixture.openPage.mock.calls).toEqual([[AUTHORIZATION_URL]]));

    await renderProvider(_fixture, snapshot(mine(_fixture)));
    await expect
      .element(page.getByText("Complete the official Antigravity sign-in in your browser."))
      .toBeVisible();
    expect(_fixture.openPage).toHaveBeenCalledTimes(1);
  });

  it("opens once after a renderer reload during the slow start", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    _fixture.serverStart.mockReturnValue(new Promise<never>(() => undefined));
    await renderProvider(_fixture, snapshot());
    await page.getByRole("button", { name: "Sign in with Google" }).click();
    await closeView(_fixture, snapshot(starting(_fixture)));

    resetProviderSignInForTests({ open: _fixture.openPage, reload: true, claim: _fixture.claim });
    await renderProvider(_fixture, snapshot(starting(_fixture)));
    await expect.element(page.getByText("Starting Google sign-in")).toBeVisible();
    observeProviderSignInSnapshots(signInKey.environmentId, [snapshot(mine(_fixture))]);
    await renderProvider(_fixture, snapshot(mine(_fixture)));
    await vi.waitFor(() => expect(_fixture.openPage).toHaveBeenCalledTimes(1));
    await expect
      .element(page.getByText("Complete the official Antigravity sign-in in your browser."))
      .toBeVisible();
  });

  it("does not open another client's sign-in, or claim that a page is open", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await renderProvider(_fixture, snapshot(operation()));

    await expect.element(page.getByText("Open the Google sign-in page to continue.")).toBeVisible();
    expect(text(_fixture)).not.toContain("in your browser");
    expect(_fixture.openPage).not.toHaveBeenCalled();
    // Waiting on the user: a still icon, not a spinner.
    expect(_fixture.host!.querySelector(".animate-spin")).toBeNull();

    await page.getByRole("button", { name: "Open Google sign-in" }).click();
    await expect
      .element(page.getByText("Complete the official Antigravity sign-in in your browser."))
      .toBeVisible();
    expect(_fixture.openPage.mock.calls).toEqual([[AUTHORIZATION_URL]]);
    expect(_fixture.controller.startConnection).not.toHaveBeenCalled();
  });

  it("shows a safe opening failure in the visible view and reopens the same sign-in", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    using toastAdd = vi.spyOn(toastManager, "add");
    _fixture.openPage.mockRejectedValueOnce(PRIVATE_BROWSER_FAILURE);
    _fixture.serverStart.mockImplementation(async () => {
      await renderProvider(_fixture, snapshot(mine(_fixture)));
      return snapshot(mine(_fixture));
    });
    await renderProvider(_fixture, snapshot());

    await page.getByRole("button", { name: "Sign in with Google" }).click();
    await expect.element(page.getByRole("alert")).toBeVisible();
    expect(text(_fixture)).not.toContain("private-code");
    expect(text(_fixture)).not.toContain("/private/provider/profile");
    expect(toastAdd).not.toHaveBeenCalled();

    await page.getByRole("button", { name: "Reopen Google sign-in" }).click();
    await expect.poll(() => _fixture.host!.querySelector("[role=alert]")).toBeNull();
    expect(_fixture.openPage).toHaveBeenCalledTimes(2);
    expect(_fixture.serverStart).toHaveBeenCalledTimes(1);
  });

  it("reports an opening failure as a toast when no view is visible, and keeps it for the view", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const start = deferred<ServerProvider>();
    _fixture.serverStart.mockReturnValue(start.promise);
    _fixture.openPage.mockRejectedValueOnce(PRIVATE_BROWSER_FAILURE);
    using toastAdd = vi.spyOn(toastManager, "add");
    await renderProvider(_fixture, snapshot());

    await page.getByRole("button", { name: "Sign in with Google" }).click();
    await closeView(_fixture, snapshot(starting(_fixture)));
    start.resolve(snapshot(mine(_fixture)));
    await vi.waitFor(() => expect(toastAdd).toHaveBeenCalledTimes(1));
    expect(JSON.stringify(toastAdd.mock.calls[0]![0])).not.toContain("private");

    await renderProvider(_fixture, snapshot(mine(_fixture)));
    await expect.element(page.getByRole("alert")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Reopen Google sign-in" })).toBeEnabled();
  });

  it("says a blocked popup was blocked and opens it from the user's click", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    // The real opener, in a browser tab: a delayed window.open is blocked.
    resetProviderSignInForTests({ claim: _fixture.claim });
    const open = vi.spyOn(window, "open").mockReturnValueOnce(null);
    _fixture.serverStart.mockImplementation(async () => {
      await renderProvider(_fixture, snapshot(mine(_fixture)));
      return snapshot(mine(_fixture));
    });
    await renderProvider(_fixture, snapshot());

    await page.getByRole("button", { name: "Sign in with Google" }).click();
    await expect.element(page.getByRole("alert")).toBeVisible();
    await expect.element(page.getByText("Sign-in page blocked")).toBeVisible();
    expect(text(_fixture)).toContain("Open Google sign-in to continue.");
    expect(text(_fixture)).not.toContain("could not open");

    // A real same-origin window; its navigation to Google is stopped at the link.
    const frame = document.createElement("iframe");
    document.body.append(frame);
    const followed: Array<{ readonly href: string; readonly rel: string }> = [];
    frame.contentDocument!.addEventListener(
      "click",
      (event) => {
        const link = event.target as HTMLAnchorElement;
        followed.push({ href: link.href, rel: link.rel });
        event.preventDefault();
      },
      true,
    );
    open.mockReturnValueOnce(frame.contentWindow);
    await page.getByRole("button", { name: "Open Google sign-in" }).click();
    await expect.poll(() => _fixture.host!.querySelector("[role=alert]")).toBeNull();
    expect(open).toHaveBeenLastCalledWith("about:blank", "_blank", "popup");
    expect(frame.contentWindow!.opener).toBeNull();
    expect(followed).toEqual([{ href: AUTHORIZATION_URL, rel: "noreferrer" }]);
    frame.remove();
    open.mockRestore();
  });

  it("sends no referrer when it navigates the opened window", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const loaded = (frame: HTMLIFrameElement) =>
      new Promise<void>((resolve) =>
        frame.addEventListener("load", () => resolve(), { once: true }),
      );
    const target = `${location.origin}/favicon.ico?referrer-check`;
    const frames = [document.createElement("iframe"), document.createElement("iframe")];
    for (const frame of frames) document.body.append(frame);

    // Control: a navigation started from this window carries this window's URL.
    const control = loaded(frames[0]!);
    frames[0]!.contentWindow!.location.replace(target);
    await control;
    expect(frames[0]!.contentDocument!.referrer).not.toBe("");

    const navigated = loaded(frames[1]!);
    navigateWithoutReferrer(frames[1]!.contentWindow!, target);
    await navigated;
    expect(frames[1]!.contentWindow!.location.href).toBe(target);
    expect(frames[1]!.contentDocument!.referrer).toBe("");
    for (const frame of frames) frame.remove();
  });

  it("does not open a page for a sign-in cancelled during startup", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const start = deferred<ServerProvider>();
    _fixture.serverStart.mockReturnValue(start.promise);
    await renderProvider(_fixture, snapshot());
    await page.getByRole("button", { name: "Sign in with Google" }).click();
    await renderProvider(_fixture, snapshot(starting(_fixture)));
    await page.getByRole("button", { name: "Cancel Antigravity sign-in" }).click();
    const cancelled = snapshot(operation({ status: "cancelled" }));
    await renderProvider(_fixture, cancelled);
    start.resolve(cancelled);
    await expect.element(page.getByRole("button", { name: "Sign in with Google" })).toBeEnabled();
    expect(_fixture.openPage).not.toHaveBeenCalled();
    expect(_fixture.controller.cancelConnection).toHaveBeenCalledWith("auth-1");
  });

  it("says the sign-in finished when only starting a session failed", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const failed = (failedAfterSignIn: boolean) =>
      snapshot(
        operation({
          status: "failed",
          finishedAt: "2026-10-11T00:01:00.000Z",
          message: failedAfterSignIn
            ? "Antigravity authenticated, but could not initialize a session or load models."
            : "Google sign-in failed. Start sign-in again.",
          ...(failedAfterSignIn ? { failedAfterSignIn } : {}),
        }),
      );

    await renderProvider(_fixture, failed(true));
    await expect.element(page.getByText("Signed in, but Antigravity couldn’t start")).toBeVisible();
    // The next step, not the server's sentence again; and a retry, not a new Google sign-in.
    expect(text(_fixture)).toContain(
      "Your Google account is connected. Try again, or check Settings > Diagnostics if it keeps failing.",
    );
    await expect
      .element(page.getByRole("button", { name: "Try starting Antigravity again" }))
      .toBeVisible();
    expect(text(_fixture)).not.toContain("didn’t finish");

    await renderProvider(_fixture, failed(false));
    await expect.element(page.getByText("Google sign-in didn’t finish")).toBeVisible();
  });

  it("keeps a manual fallback explicit and reports its browser failure safely", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const fallback = snapshot(
      operation({
        authorizationUrlKind: "manual_fallback",
        authorizationUrl: "https://antigravity.google/docs/cli/install/#authentication-workflows",
        acceptsAuthorizationCode: false,
      }),
    );
    _fixture.serverStart.mockImplementation(async () => {
      await renderProvider(_fixture, fallback);
      return fallback;
    });
    await renderProvider(_fixture, snapshot());
    await page.getByRole("button", { name: "Sign in with Google" }).click();
    await expect.element(page.getByRole("button", { name: "Open sign-in help" })).toBeEnabled();
    expect(_fixture.openPage).not.toHaveBeenCalled();
    _fixture.openPage.mockRejectedValueOnce(PRIVATE_BROWSER_FAILURE);
    await page.getByRole("button", { name: "Open sign-in help" }).click();
    await expect.element(page.getByRole("alert")).toBeVisible();
    expect(_fixture.serverStart).toHaveBeenCalledTimes(1);
  });
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  const serverStart = vi.fn<() => Promise<ServerProvider>>();
  let requestId: string | undefined;
  const openPage = vi.fn<(url: string) => Promise<void>>();
  let latest: ServerProvider;
  const controller = {
    // As the production controller does: the shared opener runs the start command.
    startConnection: vi.fn<ProviderLifecycleController["startConnection"]>(() =>
      startProviderSignIn({
        key: signInKey,
        providerName: "Antigravity",
        previousOperationId: latest.connection?.operation?.operationId ?? null,
        start: (signInRequestId) => {
          requestId = signInRequestId;
          return serverStart();
        },
        operationOf: (provider) => provider.connection?.operation,
      }),
    ),
    cancelConnection: vi.fn<ProviderLifecycleController["cancelConnection"]>(),
    submitAuthorizationCode: vi.fn<ProviderLifecycleController["submitAuthorizationCode"]>(),
    disconnect: vi.fn<ProviderLifecycleController["disconnect"]>(),
    signInKey,
    openAuthorizationPage: vi.fn<ProviderLifecycleController["openAuthorizationPage"]>(),
    planRuntime: vi.fn<ProviderLifecycleController["planRuntime"]>(),
    startRuntime: vi.fn<ProviderLifecycleController["startRuntime"]>(),
    cancelRuntime: vi.fn<ProviderLifecycleController["cancelRuntime"]>(),
    updateExternalRuntime: vi.fn<ProviderLifecycleController["updateExternalRuntime"]>(),
    refresh: vi.fn<ProviderLifecycleController["refresh"]>(),
  } satisfies ProviderLifecycleController;
  let claim = grantOncePerOperation();
  return {
    get serverStart() {
      return serverStart;
    },
    get requestId() {
      return requestId;
    },
    set requestId(value: string | undefined) {
      requestId = value;
    },
    get openPage() {
      return openPage;
    },
    get latest() {
      return latest;
    },
    set latest(value: ServerProvider) {
      latest = value;
    },
    get controller() {
      return controller;
    },
    get claim() {
      return claim;
    },
    set claim(value: typeof claim) {
      claim = value;
    },

    host: undefined! as HTMLDivElement | undefined,
    stack,
    cleanup,
    root0: undefined! as Screen | undefined,
    async [Symbol.asyncDispose]() {
      try {
        await cleanup.disposeAsync();
      } finally {
        await stack.disposeAsync();
      }
    },
  };
}
type _Fixture = ReturnType<typeof _createFixture>;
