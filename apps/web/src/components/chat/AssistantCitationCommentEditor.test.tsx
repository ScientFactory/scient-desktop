// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";

vi.mock("~/scient/voice/ScientVoiceCommentControl", () => ({
  ScientVoiceCommentControl: ({ onTranscript }: { onTranscript: (text: string) => void }) => (
    <button
      type="button"
      aria-label="Dictate citation comment"
      onClick={() => onTranscript("Dictated context")}
    />
  ),
}));

import { AssistantCitationCommentEditor } from "./AssistantCitationCommentEditor";

let container: HTMLDivElement;
let root: Root;
const onSubmit = vi.fn(() => true);
const onCancel = vi.fn();

async function render(mode: "create" | "edit" = "edit") {
  await act(() =>
    root.render(
      <AssistantCitationCommentEditor
        citation={{ environmentId: EnvironmentId.make("local") }}
        mode={mode}
        onSubmit={onSubmit}
        onCancel={onCancel}
      />,
    ),
  );
}

async function click(label: string) {
  const button = [...container.querySelectorAll("button")].find(
    (item) => item.textContent?.trim() === label,
  );
  expect(button, label).toBeDefined();
  await act(() => button!.click());
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("assistant citation comment actions", () => {
  it("saves when editing an existing citation comment", async () => {
    await render();
    expect(container.textContent).toContain("Save");
    expect(container.textContent).not.toContain("Add to chat");

    await click("Save");

    expect(onSubmit).toHaveBeenCalledWith("");
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("adds a new citation to chat with or without a comment", async () => {
    await render("create");
    expect(container.textContent).toContain("Add to chat");
    expect(container.textContent).not.toContain("Save");

    await click("Add to chat");

    expect(onSubmit).toHaveBeenCalledWith("");
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("keeps cancel separate from the primary action", async () => {
    await render("create");
    await click("Cancel");

    expect(onCancel).toHaveBeenCalledOnce();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("inserts voice text into the optional comment without submitting it", async () => {
    await render("create");
    const microphone = container.querySelector<HTMLButtonElement>(
      '[aria-label="Dictate citation comment"]',
    );
    expect(microphone).not.toBeNull();
    await act(() => microphone!.click());

    expect(container.querySelector<HTMLTextAreaElement>("textarea")?.value).toBe(
      "Dictated context",
    );
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
