import "~/index.css";
import "./accounts.css";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import {
  DEFAULT_BROWSER_PROFILE_ID,
  EnvironmentId,
  type DesktopChromeSignInResult,
} from "@t3tools/contracts";
import { render, stubGlobal } from "../../../test/render";
import { useChromeSignIn } from "./ChromeSignIn";

const state = vi.hoisted(() => ({
  toast: vi.fn(),
  recorded: vi.fn(),
  noted: vi.fn(),
  intoMain: vi.fn(),
}));
vi.mock("~/components/ui/toast", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/components/ui/toast")>()),
  toastManager: { add: state.toast },
}));
vi.mock("../analytics/accountBrowserAnalytics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../analytics/accountBrowserAnalytics")>()),
  beginAccountBrowserObservation: () => ({ context: "consent", record: state.recorded }),
}));
vi.mock("./googleCopyObservation", () => ({ noteGoogleCopy: state.noted }));
vi.mock("./importedSessions", () => ({ recordImportedSessions: async () => undefined }));
vi.mock("./mainFill", () => ({ chromeSignInIntoMain: state.intoMain }));

const environmentId = EnvironmentId.make("synthetic");
const work = { id: "profile-work", name: "Work" };
const main = { id: DEFAULT_BROWSER_PROFILE_ID, name: "Main" };

function Harness(props: { profile: typeof work; url?: string; purpose?: "google" | "site" }) {
  const chromeSignIn = useChromeSignIn(environmentId);
  return (
    <>
      <button
        type="button"
        onClick={() => chromeSignIn.start(props.profile, props.url, props.purpose)}
      >
        Start
      </button>
      {chromeSignIn.dialog}
    </>
  );
}

function setup() {
  state.toast.mockReset();
  state.recorded.mockReset();
  state.noted.mockReset();
  state.intoMain.mockReset();
  const result = Promise.withResolvers<DesktopChromeSignInResult>();
  const chromeSignIn = vi.fn(() => result.promise);
  state.intoMain.mockImplementation(() => result.promise);
  const bridge = stubGlobal("desktopBridge", {
    getLocalEnvironmentBootstraps: () => [],
    getClientPlatform: () => "win32",
    accounts: {
      chromeSignIn,
      chromeSignInBrowser: async () => ({ name: "Edge", canQuit: true }),
      endChromeSignIn: async () => true,
    },
  });
  return { result, chromeSignIn, [Symbol.dispose]: () => bridge[Symbol.dispose]() };
}

/** Runs one window to its result; what the person was told and the run's one observation. */
async function finish(f: ReturnType<typeof setup>, result: DesktopChromeSignInResult) {
  f.result.resolve(result);
  // The report follows the dialog's closing in the same turn.
  await expect.element(page.getByRole("heading", { name: /^Sign in in / })).not.toBeInTheDocument();
  expect(state.recorded).toHaveBeenCalledOnce();
  return {
    toast: state.toast.mock.calls[0]?.[0] as { type: string; title: string } | undefined,
    observed: state.recorded.mock.calls[0]![1] as Record<string, string>,
  };
}

it("names the browser and helps with Windows passkey prompts while the window is open", async () => {
  using f = setup();
  await using _screen = await render(<Harness profile={work} />);
  await page.getByRole("button", { name: "Start" }).click();
  await expect.element(page.getByRole("heading", { name: "Sign in in Edge" })).toBeVisible();
  await expect.element(page.getByText(/If Windows Security asks for a passkey/)).toBeVisible();
  await expect.element(page.getByText(/temporary profile/)).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Done", exact: true })).toBeVisible();
  const { observed } = await finish(f, { outcome: "cancelled", browser: "Microsoft Edge" });
  expect(observed).toEqual({
    variant: "cancelled",
    browser: "edge",
    purpose: "google",
    google: "none",
  });
});

it("never reports a copy Google refused or couldn't be asked about as a success", async () => {
  for (const [google, type] of [
    ["rejected", "error"],
    ["unknown", "info"],
    ["accepted", "success"],
  ] as const) {
    using f = setup();
    await using _screen = await render(<Harness profile={work} />);
    await page.getByRole("button", { name: "Start" }).click();
    const { toast, observed } = await finish(f, {
      outcome: "copied",
      browser: "Google Chrome",
      sites: ["google.com"],
      google,
    });
    expect(toast?.type).toBe(type);
    expect(observed).toMatchObject({ variant: "copied", browser: "chrome", google });
    // Google's cookies went into a profile with no working Google session: a copy to follow.
    expect(state.noted).toHaveBeenCalledWith(
      environmentId,
      work.id,
      "browser_window",
      expect.objectContaining({ context: "consent" }),
    );
  }
});

it("doesn't follow a copy over a Google session the profile already had", async () => {
  using f = setup();
  await using _screen = await render(<Harness profile={work} />);
  await page.getByRole("button", { name: "Start" }).click();
  await finish(f, {
    outcome: "copied",
    browser: "Edge",
    sites: ["google.com"],
    google: "accepted",
    googleHeldBefore: true,
  });
  expect(state.noted).not.toHaveBeenCalled();
});

it("reports a copy into Main that kept one of Main's own sign-ins as partial", async () => {
  using f = setup();
  await using _screen = await render(<Harness profile={main} />);
  await page.getByRole("button", { name: "Start" }).click();
  const { toast, observed } = await finish(f, {
    outcome: "copied",
    browser: "Edge",
    sites: ["google.com", "overleaf.com"],
    main: {
      units: [
        { sites: ["google.com"], outcome: "copied" },
        { sites: ["overleaf.com"], outcome: "conflict" },
      ],
      unsupported: 0,
    },
    google: "accepted",
  });
  expect(toast?.type).toBe("info");
  expect(toast?.title).toContain("overleaf.com");
  expect(observed).toMatchObject({ variant: "partial", google: "accepted" });
  expect(f.chromeSignIn).not.toHaveBeenCalled();
  expect(state.intoMain).toHaveBeenCalledWith(environmentId, "https://accounts.google.com/");
  expect(state.noted).toHaveBeenCalledWith(
    environmentId,
    DEFAULT_BROWSER_PROFILE_ID,
    "browser_window",
    expect.objectContaining({ context: "consent" }),
  );
});
