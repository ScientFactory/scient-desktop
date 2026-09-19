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
  it("anchors the recording overlay to the footer above the footer's provider icon", () => {
    // The overlay must out-stack ProviderInstanceIcon's `relative isolate
    // z-30` avatar (upstream), otherwise the agent avatar at the footer's
    // left edge paints over the start of the waveform.
    expect(voiceControlSource).toContain(
      '"absolute inset-0 z-40 flex items-center gap-2 bg-background"',
    );
    expect(
      NodeFS.readFileSync(
        new URL("../../components/chat/ProviderInstanceIcon.tsx", import.meta.url),
        "utf8",
      ),
    ).toContain("relative isolate z-30");
    expect(voiceControlSource).toContain(
      'presentation === "composer" ? "px-3 pb-3 sm:px-4 sm:pb-4" : null',
    );
    expect(composerSource).toMatch(
      /data-chat-composer-footer="true"[\s\S]{0,300}"relative flex min-w-0/u,
    );
  });
});
