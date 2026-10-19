import "../../index.css";

import {
  EnvironmentId,
  ProviderInstanceId,
  type ProviderConnectionOperation,
} from "@t3tools/contracts";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { page } from "vitest/browser";

// Toasts read the current thread from the route; there is none here.
vi.mock("@tanstack/react-router", () => ({ useParams: () => null }));

import { ToastProvider } from "../../components/ui/toast";
import { resetProviderSignInBrowserForTests, startProviderSignIn } from "./providerSignInBrowser";

let root: Root | undefined;
let host: HTMLDivElement | undefined;

afterEach(() => {
  root?.unmount();
  host?.remove();
  root = undefined;
  host = undefined;
  resetProviderSignInBrowserForTests();
});

function waiting(signInRequestId: string, operationId: string): ProviderConnectionOperation {
  return {
    operationId,
    method: "antigravity_google",
    status: "waiting_for_browser",
    startedAt: "2026-10-19T00:00:00.000Z",
    finishedAt: null,
    message: "Finish signing in.",
    authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?client_id=synthetic-test",
    authorizationUrlKind: "primary",
    signInRequestId,
  };
}

/** The number of lines the title's text wraps to. */
function titleLines(text: string): number {
  const title = [...document.querySelectorAll<HTMLElement>('[data-slot="toast-title"]')].find(
    (element) => element.textContent === text,
  );
  if (!title) return 0;
  const range = document.createRange();
  range.selectNodeContents(title);
  return new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size;
}

it.each([
  ["blocked", "Antigravity sign-in page blocked"],
  ["failed", "Antigravity sign-in page didn’t open"],
] as const)("keeps the %s notification title on one line", async (outcome, title) => {
  await page.viewport(1000, 650);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  root.render(<ToastProvider />);
  // The provider must be listening before the notification is added.
  await new Promise((resolve) => setTimeout(resolve, 50));
  // The real opener: a browser tab whose popup is blocked, or a page that fails to open.
  resetProviderSignInBrowserForTests({
    claim: async () => true,
    ...(outcome === "failed"
      ? { open: () => Promise.reject(new Error("The system browser refused.")) }
      : {}),
  });
  const open = vi.spyOn(window, "open").mockReturnValue(null);
  await startProviderSignIn({
    key: {
      environmentId: EnvironmentId.make("local"),
      instanceId: ProviderInstanceId.make("antigravity"),
    },
    providerName: "Antigravity",
    previousOperationId: null,
    start: async (id) => waiting(id, `connect-${outcome}`),
    operationOf: (operation) => operation,
  });
  open.mockRestore();
  await expect.element(page.getByText(title)).toBeVisible();
  expect(titleLines(title)).toBe(1);
});
