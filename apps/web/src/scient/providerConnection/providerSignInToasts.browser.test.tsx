import { render as _fixtureRender, type Screen } from "../../../test/render";
import "../../index.css";

import {
  EnvironmentId,
  ProviderInstanceId,
  type ProviderConnectionOperation,
} from "@t3tools/contracts";

import { expect, it, vi } from "vite-plus/test";
import { page } from "vitest/browser";

// Toasts read the current thread from the route; there is none here.
vi.mock("@tanstack/react-router", async (_actualRouter) => ({
  ...(await _actualRouter<typeof import("@tanstack/react-router")>()),
  useParams: () => null,
}));

import { ToastProvider } from "../../components/ui/toast";
import { resetProviderSignInForTests, startProviderSignIn } from "./providerSignInFlow";

async function _cleanupFixture0(_fixture: _Fixture) {
  await _fixture.root0?.unmount();
  _fixture.host?.remove();
  _fixture.root0 = undefined;
  _fixture.host = undefined;
  resetProviderSignInForTests();
}

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

// regression: 84e819ea53 fix(providers): shorten the sign-in failure notification title
it.each([
  ["blocked", "Antigravity sign-in page blocked"],
  ["failed", "Antigravity sign-in didn’t open"],
] as const)("keeps the %s notification title on one line", async (outcome, title) => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  await page.viewport(1000, 650);
  _fixture.host = document.createElement("div");
  document.body.append(_fixture.host);
  _fixture.root0 = _fixture.stack.use(
    await _fixtureRender(null, { container: _fixture.host, router: false }),
  );
  await _fixture.root0.rerender(<ToastProvider />);
  await vi.waitFor(() =>
    expect(document.querySelector('[data-slot="toast-viewport"]')).not.toBeNull(),
  );
  // The real opener: a browser tab whose popup is blocked, or a page that fails to open.
  resetProviderSignInForTests({
    claim: async () => ({
      granted: true,
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?client_id=synthetic-test",
    }),
    ...(outcome === "failed"
      ? { open: () => Promise.reject(new Error("The system browser refused.")) }
      : {}),
  });
  using _open = vi.spyOn(window, "open").mockReturnValue(null);
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
  await expect.element(page.getByText(title)).toBeVisible();
  expect(titleLines(title)).toBe(1);
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
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
