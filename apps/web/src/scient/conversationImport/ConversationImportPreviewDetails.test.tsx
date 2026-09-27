// @vitest-environment happy-dom
import type { ScientConversationImportPreview } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { ConversationImportPreviewDetails } from "./ConversationImportPreviewDetails";

const preview = {
  kind: "scic",
  conversation: { title: "Field notes", provider: "codex", model: "gpt-5" },
  counts: { messages: 12, attachments: 2 },
  omissions: [
    { _tag: "work-log-excluded" },
    { _tag: "reasoning-excluded" },
    { _tag: "range-truncated", throughMessageN: 12 },
    {
      _tag: "snapshot-warning",
      warning: { _tag: "attachment-unavailable", name: "notes.pdf", messageN: 3 },
    },
    {
      _tag: "snapshot-warning",
      warning: { _tag: "running-turn-omitted", turnId: "turn-1" },
    },
  ],
  warnings: [
    {
      _tag: "export-warning",
      warning: {
        code: "resource-unresolved",
        message: "The linked image <script>alert(1)</script> was unavailable.",
      },
    },
    { _tag: "newer-minor-version", formatVersion: { major: 1, minor: 3 } },
  ],
} as unknown as ScientConversationImportPreview;

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("conversation import preview", () => {
  it("shows every actual omission and warning before confirmation as plain text", async () => {
    await act(() => root.render(<ConversationImportPreviewDetails preview={preview} />));

    const omissions = container.querySelector('[aria-label="Content not included"]');
    expect(omissions?.querySelectorAll("li")).toHaveLength(5);
    expect(omissions?.textContent).toContain("sender excluded the work log");
    expect(omissions?.textContent).toContain("sender excluded reasoning");
    expect(omissions?.textContent).toContain("Messages after message 12");
    expect(omissions?.textContent).toContain("notes.pdf");
    expect(omissions?.textContent).toContain("turn still running");

    const warnings = container.querySelector('[aria-label="Import warnings"]');
    expect(warnings?.querySelectorAll("li")).toHaveLength(2);
    expect(warnings?.textContent).toContain("linked image <script>alert(1)</script>");
    expect(warnings?.textContent).toContain("format version 1.3");
    expect(warnings?.querySelector("script")).toBeNull();
    expect(container.textContent).toContain("12 messages · 2 attachments · from codex · gpt-5");
  });

  it("identifies ordinary Markdown as a document and omits empty notice sections", async () => {
    await act(() =>
      root.render(
        <ConversationImportPreviewDetails
          preview={{
            ...preview,
            kind: "document",
            conversation: { ...preview.conversation, provider: null, model: null },
            omissions: [],
            warnings: [],
          }}
        />,
      ),
    );

    expect(container.textContent).toContain("starts a conversation with the document attached");
    expect(container.textContent).not.toContain("from null");
    expect(container.querySelector('[aria-label="Content not included"]')).toBeNull();
    expect(container.querySelector('[aria-label="Import warnings"]')).toBeNull();
  });
});
