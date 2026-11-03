import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { EnvironmentId, ThreadId, defaultAccountControls } from "@t3tools/contracts";
import { render } from "../../../test/render";
import { ProfileSwitcher } from "./ProfileSwitcher";

const state = vi.hoisted(() => ({
  accounts: [] as ReadonlyArray<unknown>,
  profiles: [] as ReadonlyArray<{ id: string; name: string }>,
  choose: vi.fn(),
  addBrowserProfile: vi.fn(),
}));
vi.mock("./useAccounts", () => ({
  useAccounts: () => ({ data: { accounts: state.accounts, profiles: [] }, canWrite: true }),
  useAccountCommand: () => state.choose,
}));
vi.mock("./addBrowserProfile", () => ({ addBrowserProfile: state.addBrowserProfile }));
vi.mock("./BrowserProfiles", () => ({ BrowserImportDialog: () => <p>Import wizard</p> }));
// The desktop, where another browser's profiles can be read.
vi.mock("~/components/preview/previewBridge", () => ({ previewBridge: {} }));
vi.mock("~/hooks/useSettings", async (original) => ({
  ...(await original<object>()),
  useClientSettings: (select: (settings: object) => unknown) =>
    select({ browserProfiles: state.profiles, browserDefaultProfileId: "default" }),
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

function reset() {
  state.accounts = [];
  state.profiles = [];
  state.choose.mockReset();
  state.addBrowserProfile.mockReset();
}

const switcher = (activeProfileId: string, onOpenInProfile = vi.fn()) => (
  <ProfileSwitcher
    threadRef={threadRef}
    url="https://www.example.com/inbox"
    activeProfileId={activeProfileId}
    onOpenInProfile={onOpenInProfile}
  />
);

it("names the profiles signed in to the page in the menu, and adds nothing to the toolbar", async () => {
  reset();
  state.accounts = [signedInOnWork];
  state.profiles = [
    { id: "home", name: "Home" },
    { id: "work", name: "Work" },
  ];
  const onOpenInProfile = vi.fn();
  await using screen = await render(switcher("home", onOpenInProfile));
  expect(screen.container.textContent).not.toContain("Signed in");
  await page.getByRole("button", { name: "Profile: Home" }).click();
  await page.getByRole("menuitem", { name: /Work/ }).click();
  expect(onOpenInProfile).toHaveBeenCalledWith("work");
  expect(state.choose).toHaveBeenCalledWith(expect.objectContaining({ profileId: "work" }));
});

it("shows Main alone and opens an incognito tab without remembering it", async () => {
  reset();
  const onOpenInProfile = vi.fn();
  await using _screen = await render(switcher("default", onOpenInProfile));
  await page.getByRole("button", { name: "Profile: Main" }).click();
  await expect.element(page.getByRole("menuitem", { name: "Main" })).toBeVisible();
  await page.getByRole("menuitem", { name: "New incognito tab" }).click();
  expect(onOpenInProfile).toHaveBeenCalledExactlyOnceWith("incognito");
  expect(state.choose).not.toHaveBeenCalled();
});

it("adds a profile and moves the page into it", async () => {
  reset();
  state.addBrowserProfile.mockResolvedValue("profile-new");
  const onOpenInProfile = vi.fn();
  await using _screen = await render(switcher("default", onOpenInProfile));
  await page.getByRole("button", { name: "Profile: Main" }).click();
  await page.getByRole("menuitem", { name: "New profile" }).click();
  await vi.waitFor(() => expect(onOpenInProfile).toHaveBeenCalledWith("profile-new"));
  expect(state.choose).toHaveBeenCalledWith(expect.objectContaining({ profileId: "profile-new" }));
});

it("offers the browser import on the desktop", async () => {
  reset();
  await using _screen = await render(switcher("default"));
  await page.getByRole("button", { name: "Profile: Main" }).click();
  await page.getByRole("menuitem", { name: "Import from a browser…" }).click();
  await expect.element(page.getByText("Import wizard")).toBeVisible();
});

it("stays out of an incognito tab", async () => {
  reset();
  await using screen = await render(switcher("incognito"));
  expect(screen.container.querySelector("button")).toBeNull();
});

it("says why the tab opened in its profile", async () => {
  reset();
  state.accounts = [
    { ...signedInOnWork, signIn: { state: "signed-in", at: "2026-11-03T11:41:00Z" } },
  ];
  state.profiles = [
    { id: "home", name: "Home" },
    { id: "work", name: "Work" },
  ];
  await using _screen = await render(switcher("work"));
  await page.getByRole("button", { name: "Profile: Work" }).click();
  await expect.element(page.getByText("Work · signed in to example.com")).toBeVisible();
});
