import "~/index.css";
import { EnvironmentId, PluginSignInError, ProviderThreadId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { AppAtomRegistryProvider, appAtomRegistry } from "../../rpc/atomRegistry";
import { localEnvironmentIdAtom } from "../../state/primaryEnvironment";
import { PluginSignInAction } from "./PluginSignInAction";

const environmentId = EnvironmentId.make("synthetic-local");
const threadId = ThreadId.make("thread-plugin");
const providerThreadId = ProviderThreadId.make("provider-thread-plugin");
const pluginSignIn = { attemptId: "attempt-1", plugin: "gmail", displayName: "Gmail" };
const SIGN_IN_PAGE = "https://accounts.google.com/o/oauth2/v2/auth?state=synthetic";

const fixture = vi.hoisted(() => ({
  items: [] as Array<{ readonly item: unknown }>,
  open: vi.fn(),
  opening: "opened" as "opened" | "blocked",
}));

vi.mock("./pluginSignInCommands", () => ({
  pluginSignInOpenCommand: { permissionAtom: () => Atom.make(true) },
}));
vi.mock("../../state/primaryEnvironment", () => ({
  localEnvironmentIdAtom: Atom.make<string | null>("synthetic-local"),
}));
vi.mock("../../state/entities", () => ({
  useQuietThreadVisibleTurnItems: () => fixture.items,
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => fixture.open,
}));
vi.mock("../extensions/openAuthorizationPage", () => ({
  openAuthorizationPage: async (requestUrl: () => Promise<string | null>) => {
    const url = await requestUrl();
    if (url === null) return { outcome: "not-started" };
    return fixture.opening === "opened" ? { outcome: "opened" } : { outcome: "blocked", url };
  },
}));

const local = localEnvironmentIdAtom as Atom.Writable<string | null>;

/** Resets the shared fixture when the test ends. */
function setup() {
  return {
    [Symbol.dispose]: () => {
      fixture.items = [];
      fixture.opening = "opened";
      fixture.open.mockReset();
      appAtomRegistry.set(local, "synthetic-local");
    },
  };
}

const action = (overrides: Partial<typeof pluginSignIn & { signedIn: boolean }> = {}) => (
  <AppAtomRegistryProvider>
    <PluginSignInAction
      environmentId={environmentId}
      threadId={threadId}
      providerThreadId={providerThreadId}
      pluginSignIn={{ ...pluginSignIn, ...overrides }}
    />
  </AppAtomRegistryProvider>
);

it("opens the page on a click, then takes the user's word that they signed in", async () => {
  using _fixture = setup();
  fixture.open.mockResolvedValue({ _tag: "Success", value: { authorizationUrl: SIGN_IN_PAGE } });
  await using _screen = await render(action());
  await page.getByRole("button", { name: "Sign in to Gmail" }).click();
  expect(fixture.open).toHaveBeenCalledWith({
    environmentId,
    input: { threadId, providerThreadId, attemptId: "attempt-1" },
  });
  await page.getByRole("button", { name: "I've signed in" }).click();
  await expect.element(page.getByText("Signed in")).toBeVisible();
});

it("offers the page as a link when the browser blocked the new tab", async () => {
  using _fixture = setup();
  fixture.opening = "blocked";
  fixture.open.mockResolvedValue({ _tag: "Success", value: { authorizationUrl: SIGN_IN_PAGE } });
  await using _screen = await render(action());
  await page.getByRole("button", { name: "Sign in to Gmail" }).click();
  await expect
    .element(page.getByRole("link", { name: "Open sign-in page" }))
    .toHaveAttribute("href", SIGN_IN_PAGE);
});

it("asks for a new attempt once the agent's sign-in has ended", async () => {
  using _fixture = setup();
  fixture.open.mockResolvedValue({
    _tag: "Failure",
    cause: Cause.fail(new PluginSignInError({ reason: "expired", detail: "ended" })),
  });
  await using _screen = await render(action());
  await page.getByRole("button", { name: "Sign in to Gmail" }).click();
  await expect.element(page.getByText("Ask the agent to try again")).toBeVisible();
});

it("shows Signed in once the plugin's next call worked", async () => {
  using _fixture = setup();
  fixture.items = [
    {
      item: {
        type: "system_notice",
        pluginSignIn: { ...pluginSignIn, signedIn: true },
      },
    },
  ];
  await using _screen = await render(action());
  await expect.element(page.getByText("Signed in")).toBeVisible();
  await expect.element(page.getByRole("button")).not.toBeInTheDocument();
});

it("never offers the page to a client on another computer", async () => {
  using _fixture = setup();
  appAtomRegistry.set(local, null);
  await using _screen = await render(action());
  await expect
    .element(page.getByText("Sign in on the computer that runs this agent"))
    .toBeVisible();
  expect(fixture.open).not.toHaveBeenCalled();
});
