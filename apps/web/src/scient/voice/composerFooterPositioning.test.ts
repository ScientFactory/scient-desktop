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
  it("anchors the recording overlay to the footer, clear of the provider icon", () => {
    // The overlay must start right of ProviderInstanceIcon's `relative isolate
    // z-30` avatar (upstream), so the agent avatar at the footer's left edge
    // stays visible and the waveform begins just past it instead of being
    // overlapped or covered.
    expect(voiceControlSource).toContain(
      '"absolute inset-y-0 right-0 z-40 flex items-center gap-2 bg-background"',
    );
    expect(
      NodeFS.readFileSync(
        new URL("../../components/chat/ProviderInstanceIcon.tsx", import.meta.url),
        "utf8",
      ),
    ).toContain("relative isolate z-30");
    expect(voiceControlSource).toContain(
      'presentation === "composer"\n            ? "left-9 pe-3 pb-3 sm:left-10 sm:pe-4 sm:pb-4"',
    );
    expect(composerSource).toMatch(
      /data-chat-composer-footer="true"[\s\S]{0,300}"relative flex min-w-0/u,
    );
  });
});
