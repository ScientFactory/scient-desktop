import { expect, it } from "vite-plus/test";
import composer from "./ChatComposer.tsx?raw";
import preview from "../preview/PreviewView.tsx?raw";
import control from "../../scient/voice/ScientVoiceComposerControl.tsx?raw";

it("the chat composer has a single dictation entry point and delegates its shortcut to it", () => {
  expect(composer.match(/<ScientVoiceComposerControl\b/g)).toHaveLength(1);
  expect(composer).not.toMatch(
    /useEnvironmentSpeechInput|ComposerSpeechButton|VoiceInputSetup|useDictationShortcut/,
  );
  expect(control.match(/useDictationShortcut\(/g)).toHaveLength(1);
});

it("desktop preview registers neither the T3 annotation controller nor its guest shortcut", () => {
  expect(preview).toMatch(/!isElectron && pickActive && runtimeTabId && annotationVoice/);
  expect(preview).toMatch(/DesktopPreviewAnnotationVoiceConfig \| null = isElectron\s*\? null/);
  expect(preview).toContain("bridge.pickElement(runtimeTabId, voice ?? undefined)");
});
