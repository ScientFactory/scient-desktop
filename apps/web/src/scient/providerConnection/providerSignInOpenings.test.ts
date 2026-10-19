import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const toast = vi.hoisted(() => ({ add: vi.fn() }));
vi.mock("../../components/ui/toast", () => ({ toastManager: toast }));

import {
  openProviderSignInPage,
  resetProviderSignInOpeningsForTests,
} from "./providerSignInOpenings";

const key = {
  environmentId: EnvironmentId.make("environment-1"),
  instanceId: ProviderInstanceId.make("antigravity"),
};
const url = "https://accounts.google.com/o/oauth2/v2/auth?client_id=synthetic-test";
const page = { key, operationId: "connect-1", url, providerName: "Antigravity" };
const windowOpen = vi.fn<(url: string, target: string, features: string) => unknown>();

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("window", { open: windowOpen });
  resetProviderSignInOpeningsForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("provider sign-in page opening failures", () => {
  it("closes the blank window when navigating it fails, and offers the page again", async () => {
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
    await openProviderSignInPage(page);
    expect(opened.close).toHaveBeenCalledTimes(1);
    expect(toast.add).toHaveBeenCalledTimes(1);
    const notice = toast.add.mock.calls[0]![0] as {
      readonly title: string;
      readonly actionProps: { readonly children: string };
    };
    expect(notice.title).toBe("Antigravity sign-in didn’t open");
    expect(notice.actionProps.children).toBe("Open");
  });

  it("treats a blocked popup as failed and offers the user's own click", async () => {
    windowOpen.mockReturnValue(null);
    await openProviderSignInPage(page);
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
    const open = vi.fn<(url: string) => Promise<void>>(async () => undefined);
    open.mockRejectedValueOnce(new Error("Unable to open /private/profile?code=private-code"));
    resetProviderSignInOpeningsForTests(open);
    await openProviderSignInPage(page);
    expect(toast.add).toHaveBeenCalledTimes(1);
    const notice = toast.add.mock.calls[0]![0] as {
      readonly title: string;
      readonly description: string;
      readonly actionProps: { readonly children: string; readonly onClick: () => void };
    };
    expect(notice.title).toBe("Antigravity sign-in didn’t open");
    expect(notice.description).toBeUndefined();
    expect(notice.actionProps.children).toBe("Open");
    notice.actionProps.onClick();
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(2));
  });
});
