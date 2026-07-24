import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ComposerVoiceRecorderBar } from "./ComposerVoiceRecorderBar";

function renderRecorder(completionIntent: "insert" | "send" | null, includeSend = true) {
  return renderToStaticMarkup(
    <ComposerVoiceRecorderBar
      durationLabel="0:12"
      completionIntent={completionIntent}
      waveformLevels={[0.1, 0.5, 0.9]}
      onCancel={vi.fn()}
      onInsert={vi.fn()}
      {...(includeSend ? { onSend: vi.fn() } : {})}
    />,
  );
}

describe("ComposerVoiceRecorderBar", () => {
  it("renders distinct cancel, insert, and send actions while recording", () => {
    const markup = renderRecorder(null);

    expect(markup).toContain('aria-label="Cancel voice recording"');
    expect(markup).toContain('aria-label="Stop and insert voice note"');
    expect(markup).toContain('aria-label="Send voice note"');
    expect(markup).not.toContain("animate-spin");
  });

  it.each([
    ["insert", "Transcribing voice note to composer", "Send voice note"],
    ["send", "Transcribing voice note to send", "Stop and insert voice note"],
  ] as const)("spins only the selected %s action", (intent, activeLabel, inactiveLabel) => {
    const markup = renderRecorder(intent);

    expect(markup).toContain(`aria-label="${activeLabel}"`);
    expect(markup).toContain(`aria-label="${inactiveLabel}"`);
    expect(markup.match(/animate-spin/gu)).toHaveLength(1);
    expect(markup).toContain("opacity-40");
    expect(markup).toContain('aria-label="Cancel voice transcription"');
  });

  it("omits send for insert-only consumers", () => {
    const markup = renderRecorder(null, false);

    expect(markup).toContain('aria-label="Stop and insert voice note"');
    expect(markup).not.toContain('aria-label="Send voice note"');
  });
});
