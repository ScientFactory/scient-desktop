import "../../index.css";

import { EnvironmentId, type ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page as screenPage, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  remove: vi.fn(),
  clear: vi.fn(),
}));

vi.mock("./browserHistoryState", () => ({
  browserHistoryState: { list: mocks.list, remove: mocks.remove, clear: mocks.clear },
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) => command,
}));
vi.mock("~/browserFaviconStore", () => ({ useFaviconForThreadUrl: () => undefined }));

import { BrowserHistoryDialog } from "./BrowserHistoryDialog";

const threadRef: ScopedThreadRef = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
};

const visit = (name: string, lastVisitedAt = 1_800_000_000_000) => ({
  url: `https://${name}.test/`,
  title: name,
  lastVisitedAt,
});

const success = (value: unknown) => ({ _tag: "Success" as const, value });
const failure = { _tag: "Failure" as const, cause: new Error("offline") };

function resetServer() {
  mocks.list.mockReset().mockResolvedValue(success({ pages: [visit("nature")] }));
  mocks.remove.mockReset().mockResolvedValue(success(undefined));
  mocks.clear.mockReset().mockResolvedValue(success(undefined));
}

function open() {
  const onOpenUrl = vi.fn();
  const onClose = vi.fn();
  return {
    onOpenUrl,
    onClose,
    view: (
      <BrowserHistoryDialog
        threadRef={threadRef}
        profileId="work"
        onOpenUrl={onOpenUrl}
        onClose={onClose}
      />
    ),
  };
}

describe("BrowserHistoryDialog", () => {
  it("opens a page and closes", async () => {
    resetServer();
    const { onClose, onOpenUrl, view } = open();
    await using _screen = await render(view);
    await screenPage.getByText("nature").click();
    expect(onClose).toHaveBeenCalledOnce();
    expect(onOpenUrl).toHaveBeenCalledWith("https://nature.test/");
  });

  it("searches on the server, once typing pauses", async () => {
    resetServer();
    const { view } = open();
    await using _screen = await render(view);
    await expect.element(screenPage.getByText("nature")).toBeVisible();
    mocks.list.mockResolvedValue(success({ pages: [visit("science")] }));
    await screenPage.getByRole("searchbox").fill("sci");

    await expect.element(screenPage.getByText("science")).toBeVisible();
    await expect.element(screenPage.getByText("nature")).not.toBeInTheDocument();
    expect(mocks.list).toHaveBeenLastCalledWith({
      environmentId: threadRef.environmentId,
      input: { profileId: "work", query: "sci" },
    });
  });

  it("ignores an older search that answers last", async () => {
    resetServer();
    let answerFirst: (value: unknown) => void = () => {};
    mocks.list.mockReturnValueOnce(new Promise((resolve) => (answerFirst = resolve)));
    const { view } = open();
    await using _screen = await render(view);
    mocks.list.mockResolvedValue(success({ pages: [visit("science")] }));
    await screenPage.getByRole("searchbox").fill("sci");
    await expect.element(screenPage.getByText("science")).toBeVisible();

    answerFirst(success({ pages: [visit("stale")] }));
    await expect.element(screenPage.getByText("science")).toBeVisible();
    await expect.element(screenPage.getByText("stale")).not.toBeInTheDocument();
  });

  it("adds the next pages under the ones already shown", async () => {
    resetServer();
    const next = { lastVisitedAt: 1, url: "https://nature.test/" };
    mocks.list.mockResolvedValueOnce(success({ pages: [visit("nature")], next }));
    const { view } = open();
    await using _screen = await render(view);
    mocks.list.mockResolvedValue(success({ pages: [visit("older")] }));
    await screenPage.getByRole("button", { name: "Show more" }).click();

    await expect.element(screenPage.getByText("older")).toBeVisible();
    await expect.element(screenPage.getByText("nature")).toBeVisible();
    expect(mocks.list).toHaveBeenLastCalledWith({
      environmentId: threadRef.environmentId,
      input: { profileId: "work", before: next },
    });
    await expect
      .element(screenPage.getByRole("button", { name: "Show more" }))
      .not.toBeInTheDocument();
  });

  it("removes a page, and puts it back if that fails", async () => {
    resetServer();
    const { view } = open();
    await using _screen = await render(view);
    const removeButton = screenPage.getByRole("button", {
      name: "Remove nature.test from history",
    });
    mocks.remove.mockResolvedValueOnce(failure);
    await removeButton.click({ force: true });
    await vi.waitFor(() => expect(mocks.remove).toHaveBeenCalledOnce());
    await expect.element(screenPage.getByText("nature", { exact: true })).toBeVisible();

    await removeButton.click({ force: true });
    await expect.element(screenPage.getByText("nature", { exact: true })).not.toBeInTheDocument();
    expect(mocks.remove).toHaveBeenLastCalledWith({
      environmentId: threadRef.environmentId,
      input: { profileId: "work", urls: ["https://nature.test/"] },
    });
  });

  it("clears everything only after asking", async () => {
    resetServer();
    const { view } = open();
    await using _screen = await render(view);
    await screenPage.getByRole("button", { name: "Clear history" }).click();
    expect(mocks.clear).not.toHaveBeenCalled();
    await screenPage
      .getByRole("alertdialog")
      .getByRole("button", { name: "Clear history" })
      .click();

    await expect.element(screenPage.getByText("Pages you visit will appear here.")).toBeVisible();
    expect(mocks.clear).toHaveBeenCalledOnce();
  });

  it("offers a retry when history can't be read", async () => {
    resetServer();
    mocks.list.mockResolvedValueOnce(failure);
    const { view } = open();
    await using _screen = await render(view);
    await screenPage.getByRole("button", { name: "Try again" }).click();
    await expect.element(screenPage.getByText("nature")).toBeVisible();
  });

  it("says when a search finds nothing", async () => {
    resetServer();
    const { view } = open();
    await using _screen = await render(view);
    mocks.list.mockResolvedValue(success({ pages: [] }));
    await userEvent.fill(screenPage.getByRole("searchbox"), "zzz");
    await expect.element(screenPage.getByText("No pages match your search.")).toBeVisible();
  });
});
