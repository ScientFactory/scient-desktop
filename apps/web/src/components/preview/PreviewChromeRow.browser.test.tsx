import "../../index.css";

import { EnvironmentId, type ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { type ComponentProps, useRef, useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";

vi.mock("~/scient/browser/browserHistoryState", () => ({
  browserHistoryState: { suggestPages: vi.fn(), suggestSearches: vi.fn() },
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => async () => ({ _tag: "Failure" }),
}));
vi.mock("~/hooks/useSettings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/hooks/useSettings")>()),
  useClientSettings: (select: (settings: Record<string, unknown>) => unknown) =>
    select({ browserSearchEngine: "google", browserSearchSuggestions: true }),
}));

import { PreviewChromeRow } from "./PreviewChromeRow";

const threadRef: ScopedThreadRef = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
};

function Row({
  onSubmit = vi.fn(),
}: {
  onSubmit?: ComponentProps<typeof PreviewChromeRow>["onSubmit"];
}) {
  const [url, setUrl] = useState("https://first.test/");
  const urlInputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <button type="button" onClick={() => setUrl("")}>
        Back to the empty page
      </button>
      <PreviewChromeRow
        threadRef={threadRef}
        profileId="default"
        incognito={false}
        url={url}
        loading={false}
        canGoBack={false}
        canGoForward={false}
        refreshDisabled={false}
        urlInputRef={urlInputRef}
        onBack={vi.fn()}
        onForward={vi.fn()}
        onRefresh={vi.fn()}
        onSubmit={onSubmit}
      />
    </>
  );
}

const address = () => page.getByRole("combobox", { name: "Search or enter URL" });

it("follows the page while focused, until someone types", async () => {
  await using _screen = await render(<Row />);
  (await address().element()).focus();
  await expect.element(address()).toHaveValue("https://first.test/");

  (document.querySelector("button") as HTMLButtonElement).click();
  await expect.element(address()).toHaveValue("");
});

it("keeps what's being typed when the page changes", async () => {
  await using _screen = await render(<Row />);
  await userEvent.type(address(), "nature");
  const typed = (await address().element()) as HTMLInputElement;
  const value = typed.value;
  expect(value).toContain("nature");

  (document.querySelector("button") as HTMLButtonElement).click();
  await expect.element(address()).toHaveValue(value);
});

it("submits what was typed, and nothing from an empty bar", async () => {
  const onSubmit = vi.fn();
  await using _screen = await render(<Row onSubmit={onSubmit} />);
  await userEvent.click(page.getByRole("button", { name: "Back to the empty page" }));
  await userEvent.click(address());
  await userEvent.keyboard("{Enter}");
  expect(onSubmit).not.toHaveBeenCalled();

  await userEvent.type(address(), "crispr");
  await userEvent.keyboard("{Enter}");
  expect(onSubmit).toHaveBeenCalledExactlyOnceWith("crispr");
});
