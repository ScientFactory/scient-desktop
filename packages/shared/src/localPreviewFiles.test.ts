import { describe, expect, it } from "vitest";

import {
  isSupportedLocalAudioPath,
  isSupportedLocalHtmlPath,
  isSupportedLocalPreviewFilePath,
  isSupportedLocalVideoPath,
  localFileViewerKindForPath,
} from "./localPreviewFiles";

describe("isSupportedLocalHtmlPath", () => {
  it.each(["lesson.html", "lesson.HTM", "/study/topics/heart.failure.html"])(
    "accepts an HTML document: %s",
    (path) => {
      expect(isSupportedLocalHtmlPath(path)).toBe(true);
    },
  );

  it.each(["lesson.md", "lesson.html.txt", "lesson", "/study/.html/lesson"])(
    "rejects a non-HTML document: %s",
    (path) => {
      expect(isSupportedLocalHtmlPath(path)).toBe(false);
    },
  );
});

describe("localFileViewerKindForPath", () => {
  it.each([
    ["README.md", "markdown"],
    ["diagram.svg", "svg"],
    ["photo.png", "image"],
    ["paper.pdf", "pdf"],
    ["report.html", "html"],
    ["recording.wav", "audio"],
    ["experiment.webm", "video"],
    ["analysis.py", "source"],
    ["archive.bin", "source"],
  ] as const)("routes %s to %s", (path, kind) => {
    expect(localFileViewerKindForPath(path)).toBe(kind);
  });
});

describe("browser-native media previews", () => {
  it.each(["talk.mp3", "voice.M4A", "recording.flac", "sound.ogg"])(
    "recognizes audio: %s",
    (path) => {
      expect(isSupportedLocalAudioPath(path)).toBe(true);
      expect(isSupportedLocalPreviewFilePath(path)).toBe(true);
    },
  );

  it.each(["demo.mp4", "clip.WEBM", "movie.mov"])("recognizes video: %s", (path) => {
    expect(isSupportedLocalVideoPath(path)).toBe(true);
    expect(isSupportedLocalPreviewFilePath(path)).toBe(true);
  });

  it("does not misclassify source files as media", () => {
    expect(isSupportedLocalAudioPath("audio.ts")).toBe(false);
    expect(isSupportedLocalVideoPath("video.json")).toBe(false);
  });
});
