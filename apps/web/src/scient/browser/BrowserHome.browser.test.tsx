import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "../../index.css";
import { render } from "../../../test/render";
import { BrowserHome } from "./BrowserHome";
import { useBrowserShortcuts } from "./browserShortcuts";

const accounts = vi.hoisted(() => ({ data: null as unknown }));
vi.mock("~/scient/accounts/useAccounts", () => ({
  useAccounts: () => ({ data: accounts.data }),
}));

const threadRef = {
  environmentId: EnvironmentId.make("environment-fixture"),
  threadId: ThreadId.make("thread-fixture"),
};

function cssColor(color: string) {
  const probe = document.createElement("div");
  probe.style.backgroundColor = color;
  document.body.append(probe);
  const resolved = getComputedStyle(probe).backgroundColor;
  probe.remove();
  return resolved;
}

function renderHome(
  onOpenUrl: (url: string) => void = vi.fn(),
  onSearch: (query: string) => void = vi.fn(),
) {
  useBrowserShortcuts.setState({ added: [], names: {}, hidden: [], visits: {} });
  accounts.data = null;
  return render(
    <BrowserHome
      threadRef={threadRef}
      profileId="main"
      onOpenUrl={onOpenUrl}
      onSearch={onSearch}
    />,
  );
}

it("searches what was typed, and ignores an empty box", async () => {
  const onSearch = vi.fn();
  await using _screen = await renderHome(undefined, onSearch);
  await expect.element(page.getByText("Scient Browser")).toBeVisible();
  const search = page.getByRole("searchbox", { name: "Search or enter an address" });
  await expect.element(search).not.toHaveFocus();

  await userEvent.fill(search, "   ");
  await userEvent.keyboard("{Enter}");
  expect(onSearch).not.toHaveBeenCalled();

  await userEvent.fill(search, "protein folding");
  await userEvent.keyboard("{Enter}");
  expect(onSearch).toHaveBeenCalledExactlyOnceWith("protein folding");
});

it("opens Google, Gmail and each shortcut", async () => {
  const onOpenUrl = vi.fn();
  await using _screen = await renderHome(onOpenUrl);
  await page.getByRole("button", { name: "Google", exact: true }).click();
  await page.getByRole("button", { name: "Gmail" }).click();
  await page.getByRole("button", { name: "PubMed" }).first().click();
  expect(onOpenUrl.mock.calls.map(([url]) => url)).toEqual([
    "https://www.google.com/",
    "https://mail.google.com/mail/",
    "https://pubmed.ncbi.nlm.nih.gov/",
  ]);
});

it("shows the university's Moodle only on that university's profile", async () => {
  const onOpenUrl = vi.fn();
  accounts.data = {
    profiles: [{ profileId: "uni", source: { email: "a@mail.huji.ac.il" } }, { profileId: "main" }],
    accounts: [],
  };
  const home = (profileId: string) => (
    <BrowserHome
      threadRef={threadRef}
      profileId={profileId}
      onOpenUrl={onOpenUrl}
      onSearch={vi.fn()}
    />
  );
  useBrowserShortcuts.setState({ added: [], names: {}, hidden: [], visits: {} });
  await using screen = await render(home("uni"));
  await page.getByRole("button", { name: "Moodle" }).click();
  expect(onOpenUrl).toHaveBeenCalledWith("https://moodle.huji.ac.il/");
  await screen.rerender(home("main"));
  await expect.element(page.getByRole("button", { name: "Moodle" })).not.toBeInTheDocument();
});

it("opens an app from the Apps menu and closes it", async () => {
  const onOpenUrl = vi.fn();
  await using _screen = await renderHome(onOpenUrl);
  await page.getByRole("button", { name: "Apps" }).click();
  await page.getByRole("button", { name: "Sheets" }).click();
  expect(onOpenUrl).toHaveBeenCalledWith("https://docs.google.com/spreadsheets/");
  await expect.element(page.getByRole("button", { name: "Sheets" })).not.toBeInTheDocument();
});

async function chooseFromMenu(shortcut: string, action: string) {
  await page.getByRole("button", { name: `${shortcut} options` }).click();
  await page.getByRole("menuitem", { name: action }).click();
}

it("shows three apps across and four rows, with the rest a scroll away", async () => {
  await using _screen = await renderHome();
  await page.getByRole("button", { name: "Apps" }).click();
  await expect.element(page.getByRole("button", { name: "Account", exact: true })).toBeVisible();
  const list = page
    .getByRole("button", { name: "Account", exact: true })
    .element()
    .closest('[data-slot="scroll-area-viewport"]')!;
  const top = (name: string) =>
    [...list.querySelectorAll("button")]
      .find((button) => button.textContent === name)!
      .getBoundingClientRect();
  expect(top("Drive").top).toBe(top("Account").top);
  expect(top("Calendar").top).toBe(top("Account").top);
  expect(top("Docs").top).toBeGreaterThan(top("Account").top);

  const { bottom } = list.getBoundingClientRect();
  expect(top("YouTube").bottom).toBeLessThanOrEqual(bottom);
  expect(top("Photos").top).toBeGreaterThan(top("YouTube").bottom);
  expect(list.scrollHeight).toBeGreaterThan(list.clientHeight);

  list.scrollTop = list.scrollHeight;
  await vi.waitFor(() => expect(top("Vids").bottom).toBeLessThanOrEqual(bottom + 1));
});

it("keeps a shortcut lit under its stronger menu button, and while the menu is open", async () => {
  await using _screen = await renderHome();
  const tile = page.getByRole("button", { name: "Calendar", exact: true });
  const options = page.getByRole("button", { name: "Calendar options" });
  const background = (element: Element) => getComputedStyle(element).backgroundColor;
  const lit = cssColor("var(--accent)");

  await tile.hover();
  expect(background(tile.element())).toBe(lit);

  await options.hover();
  expect(background(tile.element())).toBe(lit);
  const strong = background(options.element());
  expect(strong).not.toBe(lit);
  expect(strong).not.toBe("rgba(0, 0, 0, 0)");

  await options.click();
  await page.getByRole("button", { name: "Google", exact: true }).hover({ force: true });
  expect(background(tile.element())).toBe(lit);
  expect(background(options.element())).toBe(strong);
  await userEvent.keyboard("{Escape}");
});

it("removes a shortcut from its menu", async () => {
  await using _screen = await renderHome();
  await chooseFromMenu("arXiv", "Remove");
  await expect
    .element(page.getByRole("button", { name: "arXiv", exact: true }))
    .not.toBeInTheDocument();
});

it("adds a site with a name and refuses text that isn't an address", async () => {
  await using _screen = await renderHome();
  await page.getByRole("button", { name: "Add", exact: true }).click();
  const link = page.getByRole("textbox", { name: "Link" });
  await userEvent.fill(link, "not an address");
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByText("Enter a web address.")).toBeVisible();
  await userEvent.fill(link, "example.org");
  await userEvent.fill(page.getByRole("textbox", { name: "Name" }), "Lab wiki");
  await page.getByRole("button", { name: "Add", exact: true }).last().click();
  await expect.element(page.getByRole("button", { name: "Lab wiki", exact: true })).toBeVisible();
  await expect.element(link).not.toBeInTheDocument();
});

it("edits a shortcut's name and link and opens the new link", async () => {
  const onOpenUrl = vi.fn();
  await using _screen = await renderHome(onOpenUrl);
  await chooseFromMenu("Overleaf", "Edit");
  const name = page.getByRole("textbox", { name: "Name" });
  const link = page.getByRole("textbox", { name: "Link" });
  await expect.element(name).toHaveValue("Overleaf");
  await expect.element(link).toHaveValue("https://www.overleaf.com/");
  await userEvent.fill(name, "My paper");
  await userEvent.fill(link, "https://www.overleaf.com/project/abc");
  await page.getByRole("button", { name: "Save" }).click();
  await page.getByRole("button", { name: "My paper", exact: true }).click();
  expect(onOpenUrl).toHaveBeenCalledWith("https://www.overleaf.com/project/abc");
});

it("changes nothing when the edit is cancelled", async () => {
  await using _screen = await renderHome();
  await chooseFromMenu("Overleaf", "Edit");
  await userEvent.fill(page.getByRole("textbox", { name: "Name" }), "Changed");
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect.element(page.getByRole("button", { name: "Overleaf", exact: true })).toBeVisible();
  expect(useBrowserShortcuts.getState().added).toEqual([]);
});

it("keeps every label inside its circle at a narrow panel width", async () => {
  useBrowserShortcuts.setState({
    added: ["https://a-very-long-subdomain.of-a-very-long-site.example.org/"],
    names: {},
    hidden: [],
    visits: {},
  });
  await using screen = await render(
    <div data-testid="narrow" style={{ width: 260 }}>
      <BrowserHome threadRef={threadRef} profileId="main" onOpenUrl={vi.fn()} onSearch={vi.fn()} />
    </div>,
  );
  const panel = screen.container.querySelector("[data-testid=narrow]")!;
  const { right } = panel.getBoundingClientRect();
  await page.getByRole("button", { name: "Gmail" }).hover();
  for (const element of panel.querySelectorAll("button")) {
    expect(element.getBoundingClientRect().right).toBeLessThanOrEqual(right + 0.5);
  }
  for (const label of panel.querySelectorAll("span.truncate")) {
    expect(label.getBoundingClientRect().width).toBeLessThanOrEqual(80);
  }
});
