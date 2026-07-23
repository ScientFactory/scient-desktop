// FILE: ComposerVoiceRecorderBar.browser.tsx
// Purpose: Browser regression coverage for voice cancel, insert, send, and loading controls.
// Layer: Chat composer UI browser test

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ComposerVoiceRecorderBar } from "./ComposerVoiceRecorderBar";

async function mountRecorder(
  completionIntent: "insert" | "send" | null,
  options: { includeSend?: boolean } = {},
) {
  const onCancel = vi.fn();
  const onInsert = vi.fn();
  const onSend = vi.fn();
  const screen = await render(
    <ComposerVoiceRecorderBar
      durationLabel="0:12"
      completionIntent={completionIntent}
      waveformLevels={[0.1, 0.5, 0.9]}
      onCancel={onCancel}
      onInsert={onInsert}
      {...(options.includeSend === false ? {} : { onSend })}
    />,
  );

  return { screen, onCancel, onInsert, onSend };
}

describe("ComposerVoiceRecorderBar", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("offers separate cancel, stop-and-insert, and send actions while recording", async () => {
    const mounted = await mountRecorder(null);

    await page.getByRole("button", { name: "Cancel voice recording" }).click();
    await page.getByRole("button", { name: "Stop and insert voice note" }).click();
    await page.getByRole("button", { name: "Send voice note" }).click();

    expect(mounted.onCancel).toHaveBeenCalledOnce();
    expect(mounted.onInsert).toHaveBeenCalledOnce();
    expect(mounted.onSend).toHaveBeenCalledOnce();
    await mounted.screen.unmount();
  });

  it("spins only the insert action and keeps cancellation available", async () => {
    const mounted = await mountRecorder("insert");
    const cancel = page.getByRole("button", { name: "Cancel voice transcription" });
    const insert = page.getByRole("button", { name: "Transcribing voice note to composer" });
    const send = page.getByRole("button", { name: "Send voice note" });

    await expect.element(cancel).not.toBeDisabled();
    await expect.element(insert).toBeDisabled();
    await expect.element(send).toBeDisabled();
    expect(document.querySelectorAll("button .animate-spin")).toHaveLength(1);
    expect(
      document.querySelector('[aria-label="Transcribing voice note to composer"] .animate-spin'),
    ).not.toBeNull();
    expect(document.querySelector('[aria-label="Send voice note"]')?.className).toContain(
      "opacity-40",
    );
    await mounted.screen.unmount();
  });

  it("spins only the send action and dims stop-and-insert", async () => {
    const mounted = await mountRecorder("send");
    const insert = page.getByRole("button", { name: "Stop and insert voice note" });
    const send = page.getByRole("button", { name: "Transcribing voice note to send" });

    await expect.element(insert).toBeDisabled();
    await expect.element(send).toBeDisabled();
    expect(document.querySelectorAll("button .animate-spin")).toHaveLength(1);
    expect(
      document.querySelector('[aria-label="Transcribing voice note to send"] .animate-spin'),
    ).not.toBeNull();
    expect(
      document.querySelector('[aria-label="Stop and insert voice note"]')?.className,
    ).toContain("opacity-40");
    await mounted.screen.unmount();
  });

  it("supports insert-only consumers without rendering a misleading send action", async () => {
    const mounted = await mountRecorder(null, { includeSend: false });

    await expect
      .element(page.getByRole("button", { name: "Stop and insert voice note" }))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Send voice note" }))
      .not.toBeInTheDocument();
    await mounted.screen.unmount();
  });
});
