import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "../../index.css";
import { render } from "../../../test/render";
import { BrowserHome } from "./BrowserHome";
import { useBrowserShortcuts } from "./browserShortcuts";

const threadRef = {
  environmentId: EnvironmentId.make("environment-fixture"),
  threadId: ThreadId.make("thread-fixture"),
};

function renderHome(onOpenUrl: (url: string) => void = vi.fn()) {
  useBrowserShortcuts.setState({ added: [], hidden: [], visits: {} });
  return render(<BrowserHome threadRef={threadRef} onOpenUrl={onOpenUrl} />);
}

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

it("opens an app from the Apps menu and closes it", async () => {
  const onOpenUrl = vi.fn();
  await using _screen = await renderHome(onOpenUrl);
  await page.getByRole("button", { name: "Apps" }).click();
  await page.getByRole("button", { name: "Sheets" }).click();
  expect(onOpenUrl).toHaveBeenCalledWith("https://docs.google.com/spreadsheets/");
  await expect.element(page.getByRole("button", { name: "Sheets" })).not.toBeInTheDocument();
});

it("removes a shortcut", async () => {
  await using _screen = await renderHome();
  await page.getByRole("button", { name: "Remove arXiv" }).click();
  await expect.element(page.getByRole("button", { name: "arXiv" })).not.toBeInTheDocument();
});

it("adds a site and refuses text that isn't an address", async () => {
  await using _screen = await renderHome();
  await page.getByRole("button", { name: "Add", exact: true }).click();
  const address = page.getByRole("textbox", { name: "Site address" });
  await userEvent.fill(address, "not an address");
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByText("Enter a web address.")).toBeVisible();
  await userEvent.fill(address, "example.org");
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByRole("button", { name: "example.org" })).toBeVisible();
  await expect.element(address).not.toBeInTheDocument();
});

it("keeps every label inside its circle at a narrow panel width", async () => {
  useBrowserShortcuts.setState({
    added: ["https://a-very-long-subdomain.of-a-very-long-site.example.org/"],
    hidden: [],
    visits: {},
  });
  await using screen = await render(
    <div data-testid="narrow" style={{ width: 260 }}>
      <BrowserHome threadRef={threadRef} onOpenUrl={vi.fn()} />
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
