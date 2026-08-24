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
  it("anchors the recording overlay to the footer instead of the editable composer", () => {
    expect(voiceControlSource).toContain('className="absolute inset-0');
    expect(composerSource).toMatch(
      /data-chat-composer-footer="true"[\s\S]{0,300}"relative flex min-w-0/u,
    );
  });
});
