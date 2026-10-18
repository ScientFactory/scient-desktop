import "../../index.css";

import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderConnectionOperation,
  type ServerProvider,
} from "@t3tools/contracts";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page } from "vitest/browser";

import { toastManager } from "../../components/ui/toast";
import { AntigravityInlineSetup } from "./AntigravityInlineSetup";
import {
  observeProviderSignInSnapshots,
  resetProviderSignInBrowserForTests,
  startProviderSignIn,
} from "./providerSignInBrowser";
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
function mine(patch: Partial<ProviderConnectionOperation> = {}): ProviderConnectionOperation {
  return operation({ ...patch, ...(requestId ? { signInRequestId: requestId } : {}) });
}

function starting(): ProviderConnectionOperation {
  const {
    authorizationUrl: _url,
    authorizationUrlKind: _kind,
    ...value
  } = mine({ status: "starting", message: "Starting Antigravity." });
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
    connection: { methods: ["antigravity_google"], canDisconnect: false, operation: current },
  };
}

let root: Root | undefined;
let host: HTMLDivElement | undefined;

function renderProvider(provider: ServerProvider) {
  latest = provider;
  if (!host) {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  }
  flushSync(() => {
    root!.render(
      <AntigravityInlineSetup
        controller={controller}
        displayName="Antigravity"
        provider={provider}
      />,
    );
  });
}

/** The setup popover closing, while the server keeps the sign-in. */
function closeView(provider: ServerProvider) {
  latest = provider;
  flushSync(() => root!.render(null));
}

const text = () => host!.textContent ?? "";

beforeEach(() => {
  vi.resetAllMocks();
  latest = snapshot();
  requestId = undefined;
  openPage.mockResolvedValue(undefined);
  resetProviderSignInBrowserForTests({ open: openPage });
  serverStart.mockImplementation(async () => snapshot(mine()));
  controller.cancelConnection.mockResolvedValue(snapshot());
  controller.submitAuthorizationCode.mockResolvedValue(snapshot());
});

afterEach(() => {
  root?.unmount();
  host?.remove();
  root = undefined;
  host = undefined;
});

describe("Antigravity sign-in page", () => {
  it("opens once for this client even when the setup view closes during a slow start", async () => {
    const start = deferred<ServerProvider>();
    serverStart.mockReturnValue(start.promise);
    const toastAdd = vi.spyOn(toastManager, "add");
    renderProvider(snapshot());

    await page.getByRole("button", { name: "Sign in with Google" }).click();
    renderProvider(snapshot(starting()));
    await expect.element(page.getByText("Starting Google sign-in")).toBeVisible();
    expect(text()).toContain("This can take up to a minute.");

    closeView(snapshot(starting()));
    start.resolve(snapshot(mine()));
    await vi.waitFor(() => expect(openPage.mock.calls).toEqual([[AUTHORIZATION_URL]]));

    // Back in the view, and through reconnects that redeliver the same snapshot.
    renderProvider(snapshot(mine()));
    renderProvider(snapshot(mine()));
    await expect
      .element(page.getByText("Complete the official Antigravity sign-in in your browser."))
      .toBeVisible();
    closeView(snapshot(mine()));
    renderProvider(snapshot(mine()));
    await expect.element(page.getByRole("button", { name: "Reopen Google sign-in" })).toBeEnabled();
    expect(openPage).toHaveBeenCalledTimes(1);
    expect(toastAdd).not.toHaveBeenCalled();
  });

  it("opens once from the stream when the start reply is lost and the view has closed", async () => {
    serverStart.mockReturnValue(new Promise<never>(() => undefined));
    renderProvider(snapshot());
    await page.getByRole("button", { name: "Sign in with Google" }).click();
    closeView(snapshot(starting()));

    // What the app-level coordinator feeds from the provider stream.
    observeProviderSignInSnapshots(signInKey.environmentId, [snapshot(mine())]);
    observeProviderSignInSnapshots(signInKey.environmentId, [snapshot(mine())]);
    await vi.waitFor(() => expect(openPage.mock.calls).toEqual([[AUTHORIZATION_URL]]));

    renderProvider(snapshot(mine()));
    await expect
      .element(page.getByText("Complete the official Antigravity sign-in in your browser."))
      .toBeVisible();
    expect(openPage).toHaveBeenCalledTimes(1);
  });

  it("opens once after a renderer reload during the slow start", async () => {
    serverStart.mockReturnValue(new Promise<never>(() => undefined));
    renderProvider(snapshot());
    await page.getByRole("button", { name: "Sign in with Google" }).click();
    closeView(snapshot(starting()));

    resetProviderSignInBrowserForTests({ open: openPage, reload: true });
    renderProvider(snapshot(starting()));
    await expect.element(page.getByText("Starting Google sign-in")).toBeVisible();
    observeProviderSignInSnapshots(signInKey.environmentId, [snapshot(mine())]);
    renderProvider(snapshot(mine()));
    await vi.waitFor(() => expect(openPage).toHaveBeenCalledTimes(1));
    await expect
      .element(page.getByText("Complete the official Antigravity sign-in in your browser."))
      .toBeVisible();
  });

  it("does not open another client's sign-in, or claim that a page is open", async () => {
    renderProvider(snapshot(operation()));

    await expect.element(page.getByText("Open the Google sign-in page to continue.")).toBeVisible();
    expect(text()).not.toContain("in your browser");
    expect(openPage).not.toHaveBeenCalled();

    await page.getByRole("button", { name: "Open Google sign-in" }).click();
    await expect
      .element(page.getByText("Complete the official Antigravity sign-in in your browser."))
      .toBeVisible();
    expect(openPage.mock.calls).toEqual([[AUTHORIZATION_URL]]);
    expect(controller.startConnection).not.toHaveBeenCalled();
  });

  it("shows a safe opening failure in the visible view and reopens the same sign-in", async () => {
    const toastAdd = vi.spyOn(toastManager, "add");
    openPage.mockRejectedValueOnce(PRIVATE_BROWSER_FAILURE);
    serverStart.mockImplementation(async () => {
      renderProvider(snapshot(mine()));
      return snapshot(mine());
    });
    renderProvider(snapshot());

    await page.getByRole("button", { name: "Sign in with Google" }).click();
    await expect.element(page.getByRole("alert")).toBeVisible();
    expect(text()).not.toContain("private-code");
    expect(text()).not.toContain("/private/provider/profile");
    expect(toastAdd).not.toHaveBeenCalled();

    await page.getByRole("button", { name: "Reopen Google sign-in" }).click();
    await expect.poll(() => host!.querySelector("[role=alert]")).toBeNull();
    expect(openPage).toHaveBeenCalledTimes(2);
    expect(serverStart).toHaveBeenCalledTimes(1);
  });

  it("reports an opening failure as a toast when no view is visible, and keeps it for the view", async () => {
    const start = deferred<ServerProvider>();
    serverStart.mockReturnValue(start.promise);
    openPage.mockRejectedValueOnce(PRIVATE_BROWSER_FAILURE);
    const toastAdd = vi.spyOn(toastManager, "add");
    renderProvider(snapshot());

    await page.getByRole("button", { name: "Sign in with Google" }).click();
    closeView(snapshot(starting()));
    start.resolve(snapshot(mine()));
    await vi.waitFor(() => expect(toastAdd).toHaveBeenCalledTimes(1));
    expect(JSON.stringify(toastAdd.mock.calls[0]![0])).not.toContain("private");

    renderProvider(snapshot(mine()));
    await expect.element(page.getByRole("alert")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Reopen Google sign-in" })).toBeEnabled();
  });

  it("does not open a page for a sign-in cancelled during startup", async () => {
    const start = deferred<ServerProvider>();
    serverStart.mockReturnValue(start.promise);
    renderProvider(snapshot());
    await page.getByRole("button", { name: "Sign in with Google" }).click();
    renderProvider(snapshot(starting()));
    await page.getByRole("button", { name: "Cancel Antigravity sign-in" }).click();
    const cancelled = snapshot(operation({ status: "cancelled" }));
    renderProvider(cancelled);
    start.resolve(cancelled);
    await expect.element(page.getByRole("button", { name: "Sign in with Google" })).toBeEnabled();
    expect(openPage).not.toHaveBeenCalled();
    expect(controller.cancelConnection).toHaveBeenCalledWith("auth-1");
  });

  it("says the sign-in finished when only starting a session failed", async () => {
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

    renderProvider(failed(true));
    await expect.element(page.getByText("Signed in, but Antigravity couldn’t start")).toBeVisible();
    expect(text()).toContain("could not initialize a session");
    expect(text()).not.toContain("didn’t finish");

    renderProvider(failed(false));
    await expect.element(page.getByText("Google sign-in didn’t finish")).toBeVisible();
  });

  it("keeps a manual fallback explicit and reports its browser failure safely", async () => {
    const fallback = snapshot(
      operation({
        authorizationUrlKind: "manual_fallback",
        authorizationUrl: "https://antigravity.google/docs/cli/install/#authentication-workflows",
        acceptsAuthorizationCode: false,
      }),
    );
    serverStart.mockImplementation(async () => {
      renderProvider(fallback);
      return fallback;
    });
    renderProvider(snapshot());
    await page.getByRole("button", { name: "Sign in with Google" }).click();
    await expect.element(page.getByRole("button", { name: "Open sign-in help" })).toBeEnabled();
    expect(openPage).not.toHaveBeenCalled();
    openPage.mockRejectedValueOnce(PRIVATE_BROWSER_FAILURE);
    await page.getByRole("button", { name: "Open sign-in help" }).click();
    await expect.element(page.getByRole("alert")).toBeVisible();
    expect(serverStart).toHaveBeenCalledTimes(1);
  });
});
