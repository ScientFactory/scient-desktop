import {
  EnvironmentId,
  ProviderInstanceId,
  type ProviderConnectionOperation,
} from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const toast = vi.hoisted(() => ({ add: vi.fn() }));
vi.mock("../../components/ui/toast", () => ({ toastManager: toast }));

import { resetProviderSignInBrowserForTests, startProviderSignIn } from "./providerSignInBrowser";

const key = {
  environmentId: EnvironmentId.make("environment-1"),
  instanceId: ProviderInstanceId.make("antigravity"),
};
const url = "https://accounts.google.com/o/oauth2/v2/auth?client_id=synthetic-test";

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

const open = vi.fn<(url: string) => Promise<void>>();
const start = (
  current: ProviderConnectionOperation | null,
  previousOperationId: string | null = null,
) =>
  startProviderSignIn({
    key,
    providerName: "Antigravity",
    previousOperationId,
    start: async () => current,
    operationOf: (value) => value,
  });

beforeEach(() => {
  vi.resetAllMocks();
  open.mockResolvedValue(undefined);
  resetProviderSignInBrowserForTests(open);
});

describe("provider sign-in page opening", () => {
  it("opens the page of an operation this client started, once", async () => {
    await start(operation());
    // A second start joined to the same operation (row and setup view together) does not reopen it.
    await start(operation());
    expect(open.mock.calls).toEqual([[url]]);

    await start(operation({ operationId: "connect-2" }));
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("does not open what this client did not start or must not open", async () => {
    // The operation already existed before this start: another client's sign-in.
    await start(operation(), "connect-1");
    await start(operation({ authorizationUrlKind: "manual_fallback" }));
    const { authorizationUrlKind: _kind, ...unclassified } = operation();
    await start(unclassified);
    await start(operation({ status: "verifying" }));
    await start(operation({ status: "cancelled" }));
    await start(null);
    expect(open).not.toHaveBeenCalled();
  });

  it("opens nothing when the start fails", async () => {
    await expect(
      startProviderSignIn({
        key,
        providerName: "Antigravity",
        previousOperationId: null,
        start: () => Promise.reject(new Error("Sign-in is already running.")),
        operationOf: () => operation(),
      }),
    ).rejects.toThrow("Sign-in is already running.");
    expect(open).not.toHaveBeenCalled();
  });

  it("reports an opening failure as a toast with a retry when no setup view shows it", async () => {
    open.mockRejectedValueOnce(new Error("Unable to open /private/profile?code=private-code"));
    await start(operation());
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
