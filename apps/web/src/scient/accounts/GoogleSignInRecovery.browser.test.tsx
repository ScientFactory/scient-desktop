import "~/index.css";
import "./accounts.css";
import { EnvironmentId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render, stubGlobal } from "../../../test/render";
import { GoogleSignInBlockedNotice, GoogleSignInBlockedPage } from "./GoogleSignInRecovery";

vi.mock("../analytics/accountBrowserAnalytics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../analytics/accountBrowserAnalytics")>()),
  beginAccountBrowserObservation: () => ({ context: undefined, record: () => undefined }),
}));

const environmentId = EnvironmentId.make("synthetic");
const work = { id: "profile-work", name: "Work", incognito: false };

function setup() {
  const chromeSignIn = vi.fn(() => new Promise(() => undefined));
  const openExternal = vi.fn();
  const bridge = stubGlobal("desktopBridge", {
    getLocalEnvironmentBootstraps: () => [],
    getClientPlatform: () => "win32",
    accounts: {
      chromeSignIn,
      chromeSignInBrowser: async () => ({ name: "Edge", canQuit: true }),
      endChromeSignIn: async () => true,
    },
  });
  return { chromeSignIn, openExternal, [Symbol.dispose]: () => bridge[Symbol.dispose]() };
}

it("restarts another site's Continue with Google at that site, in the tab's profile", async () => {
  using f = setup();
  await using _screen = await render(
    <GoogleSignInBlockedNotice
      environmentId={environmentId}
      profile={work}
      restartUrl="https://www.overleaf.com/"
      onOpenExternal={f.openExternal}
      onDismiss={() => undefined}
    />,
  );
  await expect.element(page.getByText(/Continue with Google” on www\.overleaf\.com/)).toBeVisible();
  await page.getByRole("button", { name: "Open in my browser" }).click();
  expect(f.openExternal).toHaveBeenCalledWith("https://www.overleaf.com/");
  await page.getByRole("button", { name: "Sign in in a Chrome window" }).click();
  await expect.element(page.getByRole("heading", { name: "Sign in in Edge" })).toBeVisible();
  expect(f.chromeSignIn).toHaveBeenCalledWith({
    environmentId,
    profileId: work.id,
    url: "https://www.overleaf.com/",
  });
});

it("offers Incognito only the person's own browser, since its sign-ins aren't kept", async () => {
  using f = setup();
  await using _screen = await render(
    <GoogleSignInBlockedPage
      environmentId={environmentId}
      profile={{ ...work, incognito: true }}
      restartUrl={null}
      onOpenExternal={f.openExternal}
    />,
  );
  await page.getByRole("button", { name: "Open in my browser" }).click();
  expect(f.openExternal).toHaveBeenCalledWith("https://accounts.google.com/");
  await expect
    .element(page.getByRole("button", { name: "Sign in in a Chrome window" }))
    .not.toBeInTheDocument();
});
