import "../../index.css";

import { EnvironmentId, type ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { useRef, useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { InputGroup, InputGroupInput } from "~/components/ui/input-group";

import { render } from "../../../test/render";

const mocks = vi.hoisted(() => ({
  suggestPages: vi.fn(),
  suggestSearches: vi.fn(),
  settings: { browserSearchEngine: "google", browserSearchSuggestions: true },
}));

vi.mock("./browserHistoryState", () => ({
  browserHistoryState: {
    suggestPages: mocks.suggestPages,
    suggestSearches: mocks.suggestSearches,
  },
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: (command: unknown) => command }));
vi.mock("~/hooks/useSettings", () => ({
  useClientSettings: (select: (settings: typeof mocks.settings) => unknown) =>
    select(mocks.settings),
}));
vi.mock("~/browserFaviconStore", () => ({ useFaviconForThreadUrl: () => undefined }));

import { BrowserSuggestionInput, BrowserSuggestions } from "./BrowserSuggestions";

const threadRef: ScopedThreadRef = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
};

const success = (value: unknown) => ({ _tag: "Success" as const, value });
const failure = { _tag: "Failure" as const, cause: new Error("offline") };
const nature = { url: "https://nature.com/", title: "Nature", lastVisitedAt: 1 };

function Box({
  active,
  onPick,
  profileId = "work",
}: {
  active: boolean;
  onPick: (value: string) => void;
  profileId?: string;
}) {
  const [text, setText] = useState("");
  const anchor = useRef<HTMLDivElement>(null);
  return (
    <BrowserSuggestions
      threadRef={threadRef}
      profileId={profileId}
      text={text}
      active={active}
      anchor={anchor}
      onTextChange={setText}
      onPick={onPick}
    >
      <InputGroup ref={anchor}>
        <BrowserSuggestionInput render={<InputGroupInput aria-label="Box" />} />
      </InputGroup>
    </BrowserSuggestions>
  );
}

function reset() {
  mocks.settings.browserSearchSuggestions = true;
  mocks.suggestPages.mockReset().mockResolvedValue(success({ pages: [nature] }));
  mocks.suggestSearches
    .mockReset()
    .mockResolvedValue(success({ searches: ["nature journal", "nature reviews"] }));
}

const box = () => page.getByRole("combobox", { name: "Box" });

describe("BrowserSuggestions", () => {
  it("lists past pages, then searches", async () => {
    reset();
    await using _screen = await render(<Box active onPick={vi.fn()} />);
    await userEvent.type(box(), "nat");

    await expect.element(page.getByRole("option", { name: /Nature nature\.com/ })).toBeVisible();
    await expect.element(page.getByRole("option", { name: "nature journal" })).toBeVisible();
    expect(mocks.suggestSearches).toHaveBeenLastCalledWith({
      environmentId: threadRef.environmentId,
      input: { query: "nat", engine: "google" },
    });
  });

  it("looks in the profile it's given, and drops another profile's pages at once", async () => {
    reset();
    await using screen = await render(<Box active onPick={vi.fn()} />);
    await userEvent.type(box(), "nat");
    await expect.element(page.getByRole("option", { name: /Nature nature\.com/ })).toBeVisible();
    expect(mocks.suggestPages).toHaveBeenLastCalledWith({
      environmentId: threadRef.environmentId,
      input: { profileId: "work", query: "nat" },
    });

    let answer: (result: ReturnType<typeof success>) => void = () => {};
    mocks.suggestPages.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    await screen.rerender(<Box active onPick={vi.fn()} profileId="home" />);
    await expect
      .element(page.getByRole("option", { name: /Nature nature\.com/ }))
      .not.toBeInTheDocument();
    expect(mocks.suggestPages).toHaveBeenLastCalledWith({
      environmentId: threadRef.environmentId,
      input: { profileId: "home", query: "nat" },
    });
    answer(success({ pages: [{ ...nature, title: "Home Nature" }] }));
    await expect.element(page.getByRole("option", { name: /Home Nature/ })).toBeVisible();
  });

  it("asks once typing pauses, not on every key", async () => {
    reset();
    await using _screen = await render(<Box active onPick={vi.fn()} />);
    await userEvent.type(box(), "nature");
    await expect.element(page.getByRole("option", { name: "nature journal" })).toBeVisible();
    expect(mocks.suggestSearches.mock.calls.length).toBeLessThan("nature".length);
  });

  it("picks the highlighted suggestion with the keyboard", async () => {
    reset();
    const onPick = vi.fn();
    await using _screen = await render(<Box active onPick={onPick} />);
    await userEvent.type(box(), "nat");
    await expect.element(page.getByRole("option", { name: "nature journal" })).toBeVisible();
    await userEvent.keyboard("{ArrowDown}{ArrowDown}{Enter}");

    expect(onPick).toHaveBeenCalledExactlyOnceWith("nature journal");
    await expect.element(page.getByRole("option")).not.toBeInTheDocument();
  });

  it("opens a past page by its address when clicked", async () => {
    reset();
    const onPick = vi.fn();
    await using _screen = await render(<Box active onPick={onPick} />);
    await userEvent.type(box(), "nat");
    await page.getByRole("option", { name: /Nature nature\.com/ }).click();
    expect(onPick).toHaveBeenCalledExactlyOnceWith("https://nature.com/");
  });

  it("leaves Enter to the box when nothing is highlighted", async () => {
    reset();
    const onPick = vi.fn();
    await using _screen = await render(<Box active onPick={onPick} />);
    await userEvent.type(box(), "nat");
    await expect.element(page.getByRole("option", { name: "nature journal" })).toBeVisible();
    await userEvent.keyboard("{Enter}");
    expect(onPick).not.toHaveBeenCalled();
  });

  it("closes on Escape", async () => {
    reset();
    await using _screen = await render(<Box active onPick={vi.fn()} />);
    await userEvent.type(box(), "nat");
    await expect.element(page.getByRole("option", { name: "nature journal" })).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await expect.element(page.getByRole("option")).not.toBeInTheDocument();
  });

  it("never sends an address to the search engine", async () => {
    reset();
    await using _screen = await render(<Box active onPick={vi.fn()} />);
    await userEvent.type(box(), "intranet.corp/payroll");

    await expect.element(page.getByRole("option", { name: /Nature/ })).toBeVisible();
    expect(mocks.suggestSearches).not.toHaveBeenCalled();
  });

  it("keeps to past pages when search suggestions are off", async () => {
    reset();
    mocks.settings.browserSearchSuggestions = false;
    await using _screen = await render(<Box active onPick={vi.fn()} />);
    await userEvent.type(box(), "nat");

    await expect.element(page.getByRole("option", { name: /Nature/ })).toBeVisible();
    expect(mocks.suggestSearches).not.toHaveBeenCalled();
  });

  it("asks nothing at all until it's active, so incognito stays private", async () => {
    reset();
    await using _screen = await render(<Box active={false} onPick={vi.fn()} />);
    await userEvent.type(box(), "secret search");
    await expect.element(box()).toHaveValue("secret search");
    await expect.element(page.getByRole("option")).not.toBeInTheDocument();
    expect(mocks.suggestPages).not.toHaveBeenCalled();
    expect(mocks.suggestSearches).not.toHaveBeenCalled();
  });

  it("drops an answer for older text", async () => {
    reset();
    let answerFirst: (value: unknown) => void = () => {};
    mocks.suggestSearches.mockReturnValueOnce(new Promise((resolve) => (answerFirst = resolve)));
    await using _screen = await render(<Box active onPick={vi.fn()} />);
    await userEvent.type(box(), "na");
    await vi.waitFor(() => expect(mocks.suggestSearches).toHaveBeenCalledOnce());
    mocks.suggestSearches.mockResolvedValue(success({ searches: ["newer"] }));
    await userEvent.type(box(), "ture");
    await expect.element(page.getByRole("option", { name: "newer" })).toBeVisible();

    answerFirst(success({ searches: ["stale"] }));
    await expect.element(page.getByRole("option", { name: "newer" })).toBeVisible();
    await expect.element(page.getByRole("option", { name: "stale" })).not.toBeInTheDocument();
  });

  it("shows what it has when the search engine fails", async () => {
    reset();
    mocks.suggestSearches.mockResolvedValue(failure);
    await using _screen = await render(<Box active onPick={vi.fn()} />);
    await userEvent.type(box(), "nat");
    await expect.element(page.getByRole("option", { name: /Nature/ })).toBeVisible();
  });
});
