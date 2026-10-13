import "../../index.css";

import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderConnectionOperation,
  type ServerProvider,
} from "@t3tools/contracts";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { page } from "vitest/browser";

import { AntigravityInlineSetup } from "./AntigravityInlineSetup";
import type { ProviderLifecycleController } from "./useProviderLifecycleController";

const INSTANCE_ID = ProviderInstanceId.make("antigravity");
const OTHER_INSTANCE_ID = ProviderInstanceId.make("antigravity-other");
const PRIVATE_BROWSER_FAILURE = new Error(
  "Unable to open /private/provider/profile https://accounts.google.com/?code=private-code",
);

const controller = {
  startConnection: vi.fn<ProviderLifecycleController["startConnection"]>(),
  cancelConnection: vi.fn<ProviderLifecycleController["cancelConnection"]>(),
  submitAuthorizationCode: vi.fn<ProviderLifecycleController["submitAuthorizationCode"]>(),
  disconnect: vi.fn<ProviderLifecycleController["disconnect"]>(),
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
    authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?client_id=synthetic-test",
    authorizationUrlKind: "primary",
    acceptsAuthorizationCode: true,
    authorizationResponseKind: "callback_url",
    ...patch,
  };
}

function snapshot(
  current: ProviderConnectionOperation | null = null,
  instanceId = INSTANCE_ID,
): ServerProvider {
  return {
    instanceId,
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

async function settleBrowserActions() {
  await Promise.resolve();
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

beforeEach(() => {
  vi.resetAllMocks();
  controller.startConnection.mockResolvedValue(snapshot());
  controller.cancelConnection.mockResolvedValue(snapshot());
  controller.submitAuthorizationCode.mockResolvedValue(snapshot());
  controller.openAuthorizationPage.mockResolvedValue(undefined);
});

afterEach(() => {
  root?.unmount();
  host?.remove();
  root = undefined;
  host = undefined;
});

describe("Antigravity browser opening", () => {
  it("shows a safe first-open failure while waiting and retries the same sign-in", async () => {
    const waiting = snapshot(operation());
    controller.startConnection.mockImplementation(async () => {
      renderProvider(waiting);
      return waiting;
    });
    controller.openAuthorizationPage.mockRejectedValueOnce(PRIVATE_BROWSER_FAILURE);
    renderProvider(snapshot());

    await page.getByRole("button", { name: "Sign in with Google" }).click();
    await expect.element(page.getByRole("alert")).toBeVisible();
    expect(host!.textContent).not.toContain("private-code");
    expect(host!.textContent).not.toContain("/private/provider/profile");

    await page.getByRole("button", { name: "Reopen Google sign-in" }).click();
    await expect.poll(() => host!.querySelector("[role=alert]")).toBeNull();
    await expect.element(page.getByRole("button", { name: "Reopen Google sign-in" })).toBeEnabled();
    expect(controller.startConnection).toHaveBeenCalledTimes(1);
    expect(controller.openAuthorizationPage.mock.calls).toEqual([
      [waiting.connection!.operation!.authorizationUrl],
      [waiting.connection!.operation!.authorizationUrl],
    ]);
  });

  it("handles Reopen rejection and clears its error when a retry starts", async () => {
    const retry = deferred<void>();
    const waiting = snapshot(operation());
    controller.openAuthorizationPage
      .mockRejectedValueOnce(PRIVATE_BROWSER_FAILURE)
      .mockReturnValueOnce(retry.promise);
    renderProvider(waiting);

    await page.getByRole("button", { name: "Reopen Google sign-in" }).click();
    await expect.element(page.getByRole("alert")).toBeVisible();
    await page.getByRole("button", { name: "Reopen Google sign-in" }).click();
    await expect.poll(() => host!.querySelector("[role=alert]")).toBeNull();
    await expect
      .element(page.getByRole("button", { name: "Reopen Google sign-in" }))
      .toBeDisabled();
    retry.resolve();
    await expect.element(page.getByRole("button", { name: "Reopen Google sign-in" })).toBeEnabled();
    expect(controller.startConnection).not.toHaveBeenCalled();
    expect(controller.openAuthorizationPage.mock.calls).toEqual([
      [waiting.connection!.operation!.authorizationUrl],
      [waiting.connection!.operation!.authorizationUrl],
    ]);
  });

  it.each(["before", "after"] as const)(
    "discards browser opening errors when verification begins %s the rejection",
    async (timing) => {
      const opening = deferred<void>();
      controller.openAuthorizationPage.mockReturnValueOnce(opening.promise);
      renderProvider(snapshot(operation()));
      await page.getByRole("button", { name: "Reopen Google sign-in" }).click();
      if (timing === "before") {
        opening.reject(PRIVATE_BROWSER_FAILURE);
        await expect.element(page.getByRole("alert")).toBeVisible();
      }
      renderProvider(snapshot(operation({ status: "verifying" })));
      if (timing === "after") opening.reject(PRIVATE_BROWSER_FAILURE);
      await settleBrowserActions();
      await expect.poll(() => host!.querySelector("[role=alert]")).toBeNull();
      await expect
        .element(page.getByRole("button", { name: "Cancel Antigravity sign-in" }))
        .toBeEnabled();
    },
  );

  describe.each(["initial", "reopen"] as const)("late %s opening", (origin) => {
    it.each(["resolve", "reject"] as const)(
      "does not let an old %s clear a newer operation's pending state or error",
      async (outcome) => {
        const oldOpening = deferred<void>();
        const newOpening = deferred<void>();
        const first = snapshot(operation());
        controller.openAuthorizationPage
          .mockReturnValueOnce(oldOpening.promise)
          .mockReturnValueOnce(newOpening.promise);
        controller.startConnection.mockImplementation(async () => {
          renderProvider(first);
          return first;
        });
        renderProvider(origin === "initial" ? snapshot() : first);
        await page
          .getByRole("button", {
            name: origin === "initial" ? "Sign in with Google" : "Reopen Google sign-in",
          })
          .click();
        await expect
          .element(page.getByRole("button", { name: "Reopen Google sign-in" }))
          .toBeDisabled();

        const next = snapshot(operation({ operationId: "auth-2" }));
        renderProvider(next);
        await page.getByRole("button", { name: "Reopen Google sign-in" }).click();
        if (outcome === "resolve") oldOpening.resolve();
        else oldOpening.reject(PRIVATE_BROWSER_FAILURE);
        await settleBrowserActions();
        await expect
          .element(page.getByRole("button", { name: "Reopen Google sign-in" }))
          .toBeDisabled();
        expect(host!.querySelector("[role=alert]")).toBeNull();

        newOpening.reject(PRIVATE_BROWSER_FAILURE);
        await expect.element(page.getByRole("alert")).toBeVisible();
        await expect
          .element(page.getByRole("button", { name: "Reopen Google sign-in" }))
          .toBeEnabled();
        expect(controller.startConnection).toHaveBeenCalledTimes(origin === "initial" ? 1 : 0);
      },
    );

    it.each([
      ["cancelled", "resolve"],
      ["cancelled", "reject"],
      ["provider-switched", "resolve"],
      ["provider-switched", "reject"],
      ["unmounted", "resolve"],
      ["unmounted", "reject"],
    ] as const)("ignores a %s attempt's late %s", async (transition, outcome) => {
      const opening = deferred<void>();
      const cancellation = deferred<ServerProvider>();
      const first = snapshot(operation());
      controller.openAuthorizationPage.mockReturnValueOnce(opening.promise);
      controller.cancelConnection.mockReturnValueOnce(cancellation.promise);
      controller.startConnection.mockImplementation(async () => {
        renderProvider(first);
        return first;
      });
      renderProvider(origin === "initial" ? snapshot() : first);
      await page
        .getByRole("button", {
          name: origin === "initial" ? "Sign in with Google" : "Reopen Google sign-in",
        })
        .click();
      await expect
        .element(page.getByRole("button", { name: "Reopen Google sign-in" }))
        .toBeDisabled();

      if (transition === "cancelled") {
        await page.getByRole("button", { name: "Cancel Antigravity sign-in" }).click();
      } else if (transition === "provider-switched") {
        renderProvider(snapshot(operation(), OTHER_INSTANCE_ID));
      } else {
        flushSync(() => root!.render(null));
      }
      if (outcome === "resolve") opening.resolve();
      else opening.reject(PRIVATE_BROWSER_FAILURE);
      await settleBrowserActions();
      expect(host!.querySelector("[role=alert]")).toBeNull();

      if (transition === "cancelled") {
        await expect
          .element(page.getByRole("button", { name: "Cancel Antigravity sign-in" }))
          .toBeDisabled();
        const cancelled = snapshot(operation({ status: "cancelled" }));
        renderProvider(cancelled);
        cancellation.resolve(cancelled);
        await expect
          .element(page.getByRole("button", { name: "Sign in with Google" }))
          .toBeEnabled();
        expect(controller.cancelConnection).toHaveBeenCalledWith("auth-1");
      } else if (transition === "provider-switched") {
        await expect
          .element(page.getByRole("button", { name: "Reopen Google sign-in" }))
          .toBeEnabled();
      } else {
        expect(host!.children).toHaveLength(0);
        renderProvider(snapshot());
        await expect
          .element(page.getByRole("button", { name: "Sign in with Google" }))
          .toBeEnabled();
      }
    });
  });

  it("does not open a URL returned after cancellation during startup", async () => {
    const startup = deferred<ServerProvider>();
    const { authorizationUrl: _authorizationUrl, ...startingOperation } = operation({
      status: "starting",
    });
    const starting = snapshot(startingOperation);
    controller.startConnection.mockImplementation(() => {
      renderProvider(starting);
      return startup.promise;
    });
    renderProvider(snapshot());
    await page.getByRole("button", { name: "Sign in with Google" }).click();
    await page.getByRole("button", { name: "Cancel Antigravity sign-in" }).click();
    renderProvider(snapshot(operation({ status: "cancelled" })));
    startup.resolve(snapshot(operation()));
    await settleBrowserActions();
    await expect.element(page.getByRole("button", { name: "Sign in with Google" })).toBeEnabled();
    expect(host!.querySelector("[role=alert]")).toBeNull();
    expect(controller.openAuthorizationPage).not.toHaveBeenCalled();
  });

  it("accepts a command result before its streamed operation arrives", async () => {
    const opening = deferred<void>();
    const waiting = snapshot(operation());
    controller.startConnection.mockResolvedValue(waiting);
    controller.openAuthorizationPage.mockReturnValueOnce(opening.promise);
    renderProvider(snapshot());
    await page.getByRole("button", { name: "Sign in with Google" }).click();
    await expect
      .poll(() => controller.openAuthorizationPage.mock.calls)
      .toEqual([[waiting.connection!.operation!.authorizationUrl]]);
    renderProvider(waiting);
    opening.reject(PRIVATE_BROWSER_FAILURE);
    await expect.element(page.getByRole("alert")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Reopen Google sign-in" })).toBeEnabled();
  });

  it("stops waiting when an observed operation disappears before browser opening settles", async () => {
    const opening = deferred<void>();
    const waiting = snapshot(operation());
    controller.startConnection.mockImplementation(async () => {
      renderProvider(waiting);
      return waiting;
    });
    controller.openAuthorizationPage.mockReturnValueOnce(opening.promise);
    renderProvider(snapshot());
    await page.getByRole("button", { name: "Sign in with Google" }).click();
    await expect
      .element(page.getByRole("button", { name: "Reopen Google sign-in" }))
      .toBeDisabled();
    renderProvider(snapshot());
    await expect.element(page.getByRole("button", { name: "Sign in with Google" })).toBeEnabled();
    opening.reject(PRIVATE_BROWSER_FAILURE);
    await settleBrowserActions();
    expect(host!.querySelector("[role=alert]")).toBeNull();
    await expect.element(page.getByRole("button", { name: "Sign in with Google" })).toBeEnabled();
  });

  it.each(["resolve", "reject"] as const)(
    "does not let a superseded startup %s affect a Reopen of the same operation",
    async (outcome) => {
      const startup = deferred<ServerProvider>();
      const opening = deferred<void>();
      const waiting = snapshot(operation());
      controller.startConnection.mockImplementation(() => {
        renderProvider(waiting);
        return startup.promise;
      });
      controller.openAuthorizationPage.mockReturnValueOnce(opening.promise);
      renderProvider(snapshot());
      await page.getByRole("button", { name: "Sign in with Google" }).click();
      await page.getByRole("button", { name: "Reopen Google sign-in" }).click();
      if (outcome === "resolve") startup.resolve(waiting);
      else startup.reject(PRIVATE_BROWSER_FAILURE);
      await settleBrowserActions();
      await expect
        .element(page.getByRole("button", { name: "Reopen Google sign-in" }))
        .toBeDisabled();
      expect(host!.querySelector("[role=alert]")).toBeNull();
      expect(controller.openAuthorizationPage).toHaveBeenCalledTimes(1);
      opening.resolve();
      await expect
        .element(page.getByRole("button", { name: "Reopen Google sign-in" }))
        .toBeEnabled();
    },
  );

  it.each(["resolve", "reject"] as const)(
    "ignores an older Reopen's %s after cancellation fails and the same URL is reopened",
    async (outcome) => {
      const oldOpening = deferred<void>();
      const newOpening = deferred<void>();
      controller.openAuthorizationPage
        .mockReturnValueOnce(oldOpening.promise)
        .mockReturnValueOnce(newOpening.promise);
      controller.cancelConnection.mockRejectedValueOnce(new Error("Cancellation failed."));
      renderProvider(snapshot(operation()));
      await page.getByRole("button", { name: "Reopen Google sign-in" }).click();
      await page.getByRole("button", { name: "Cancel Antigravity sign-in" }).click();
      await expect
        .element(page.getByRole("button", { name: "Reopen Google sign-in" }))
        .toBeEnabled();
      await page.getByRole("button", { name: "Reopen Google sign-in" }).click();
      if (outcome === "resolve") oldOpening.resolve();
      else oldOpening.reject(PRIVATE_BROWSER_FAILURE);
      await settleBrowserActions();
      await expect
        .element(page.getByRole("button", { name: "Reopen Google sign-in" }))
        .toBeDisabled();
      expect(host!.querySelector("[role=alert]")).toBeNull();
      newOpening.resolve();
      await expect
        .element(page.getByRole("button", { name: "Reopen Google sign-in" }))
        .toBeEnabled();
      expect(host!.querySelector("[role=alert]")).toBeNull();
      expect(controller.startConnection).not.toHaveBeenCalled();
    },
  );

  it("keeps a manual fallback explicit and reports its browser failure safely", async () => {
    const fallback = snapshot(
      operation({
        authorizationUrlKind: "manual_fallback",
        authorizationUrl: "https://antigravity.google/docs/cli/install/#authentication-workflows",
        acceptsAuthorizationCode: false,
      }),
    );
    controller.startConnection.mockImplementation(async () => {
      renderProvider(fallback);
      return fallback;
    });
    renderProvider(snapshot());
    await page.getByRole("button", { name: "Sign in with Google" }).click();
    await expect.element(page.getByRole("button", { name: "Open sign-in help" })).toBeEnabled();
    expect(controller.openAuthorizationPage).not.toHaveBeenCalled();
    controller.openAuthorizationPage.mockRejectedValueOnce(PRIVATE_BROWSER_FAILURE);
    await page.getByRole("button", { name: "Open sign-in help" }).click();
    await expect.element(page.getByRole("alert")).toBeVisible();
    expect(controller.startConnection).toHaveBeenCalledTimes(1);
  });
});
