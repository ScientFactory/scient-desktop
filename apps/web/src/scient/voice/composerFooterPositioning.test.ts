// @effect-diagnostics nodeBuiltinImport:off -- Static audit for the inherited composer seam.
import * as NodeFS from "node:fs";
import { describe, expect, it } from "vite-plus/test";

const composerSource = NodeFS.readFileSync(
  new URL("../../components/chat/ChatComposer.tsx", import.meta.url),
  "utf8",
);
const voiceControlSource = NodeFS.readFileSync(
  new URL("./ScientVoiceComposerControl.tsx", import.meta.url),
  "utf8",
);

describe("Scient voice composer footer seam", () => {
  it("keeps voice in the expanded footer beside the provider instead of overlaying idle controls", () => {
    expect(voiceControlSource).not.toContain("bg-background");
    expect(voiceControlSource).not.toContain("absolute inset");
    expect(composerSource).toContain("iconOnly={voiceBusy}");
    expect(composerSource).toContain('className={voiceBusy ? "hidden" : "contents"}');
    expect(composerSource).toMatch(/const composerHasExpandedChrome =\s+voiceBusy \|\|/u);
    expect(composerSource).toMatch(
      /data-chat-composer-footer="true"[\s\S]{0,300}"relative flex min-w-0/u,
    );
  });
});
