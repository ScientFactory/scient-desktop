import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { EnvironmentId, ThreadId, defaultAccountControls } from "@t3tools/contracts";
import { render } from "../../../test/render";
import { ProfileSwitcher } from "./ProfileSwitcher";

const state = vi.hoisted(() => ({
  accounts: [] as ReadonlyArray<unknown>,
  choose: vi.fn(),
}));
vi.mock("./useAccounts", () => ({
  useAccounts: () => ({ data: { accounts: state.accounts, profiles: [] } }),
  useAccountCommand: () => state.choose,
}));
vi.mock("~/hooks/useSettings", async (original) => ({
  ...(await original<object>()),
  useClientSettings: (select: (settings: object) => unknown) =>
    select({
      browserProfiles: [
        { id: "home", name: "Home" },
        { id: "work", name: "Work" },
      ],
    }),
}));
vi.mock("~/state/entities", async (original) => ({
  ...(await original<object>()),
  useQuietThreadShell: () => undefined,
}));

const threadRef = {
  environmentId: EnvironmentId.make("environment-fixture"),
  threadId: ThreadId.make("thread-fixture"),
};
const signedInOnWork = {
  details: { kind: "website", profileId: "work", sites: ["example.com"] },
  secrets: {},
  controls: defaultAccountControls("website"),
};

it("names the profiles signed in to the page in the menu, and adds nothing to the toolbar", async () => {
  state.accounts = [signedInOnWork];
  const onOpenInProfile = vi.fn();
  await using screen = await render(
    <ProfileSwitcher
      threadRef={threadRef}
      url="https://www.example.com/inbox"
      activeProfileId="home"
      onOpenInProfile={onOpenInProfile}
    />,
  );
  expect(screen.container.textContent).not.toContain("Signed in");
  await page.getByRole("button", { name: "Profile: Home" }).click();
  await page.getByRole("menuitem", { name: /Work/ }).click();
  expect(onOpenInProfile).toHaveBeenCalledWith("work");
  expect(state.choose).toHaveBeenCalledWith(expect.objectContaining({ profileId: "work" }));
});

const googleRow = (state: "signed-in" | "signed-out") => ({
  details: { kind: "website", profileId: "work", sites: ["google.com"], username: "a@b.co" },
  secrets: {},
  controls: defaultAccountControls("website"),
  lastCheck: { state, at: "2026-10-31T00:00:00.000Z" },
});

it("opens Gmail in the selected profile when it holds the Google session", async () => {
  state.accounts = [googleRow("signed-in")];
  const onOpenInProfile = vi.fn();
  await using _screen = await render(
    <ProfileSwitcher
      threadRef={threadRef}
      url="https://www.example.com/"
      activeProfileId="work"
      onOpenInProfile={onOpenInProfile}
    />,
  );
  await page.getByRole("button", { name: "Open Gmail" }).click();
  expect(onOpenInProfile).toHaveBeenCalledWith("work", "https://mail.google.com/mail/");
});

it("stays on the selected profile when only another holds a Google session", async () => {
  state.accounts = [googleRow("signed-in")];
  const onOpenInProfile = vi.fn();
  await using _screen = await render(
    <ProfileSwitcher
      threadRef={threadRef}
      url="https://www.example.com/"
      activeProfileId="home"
      onOpenInProfile={onOpenInProfile}
    />,
  );
  await page.getByRole("button", { name: "Open Gmail" }).click();
  expect(onOpenInProfile).toHaveBeenCalledWith("home", "https://mail.google.com/mail/");
});

it("keeps the Gmail button when Google signed the profile out", async () => {
  state.accounts = [googleRow("signed-out")];
  const onOpenInProfile = vi.fn();
  await using _screen = await render(
    <ProfileSwitcher
      threadRef={threadRef}
      url="https://www.example.com/"
      activeProfileId="work"
      onOpenInProfile={onOpenInProfile}
    />,
  );
  await page.getByRole("button", { name: "Open Gmail" }).click();
  expect(onOpenInProfile).toHaveBeenCalledWith("work", "https://mail.google.com/mail/");
});

it("hides the Gmail button when no profile has used Google", async () => {
  state.accounts = [signedInOnWork];
  await using screen = await render(
    <ProfileSwitcher
      threadRef={threadRef}
      url="https://www.example.com/"
      activeProfileId="home"
      onOpenInProfile={vi.fn()}
    />,
  );
  await expect.element(page.getByRole("button", { name: "Profile: Home" }).first()).toBeVisible();
  expect(screen.container.querySelector('[aria-label="Open Gmail"]')).toBeNull();
});
