// @effect-diagnostics nodeBuiltinImport:off -- Static audit: answer videos stay as upstream's.
import * as NodeFS from "node:fs";

import { expect, it } from "vite-plus/test";

const source = (path: string) => NodeFS.readFileSync(new URL(path, import.meta.url), "utf8");

// Upstream replaced the video Expand button (#9253); a merge once brought it
// back. A video keeps its own full-screen control and open link.
it("gives answer videos no Expand action", () => {
  expect(source("../../components/media/MediaVideoPlayer.tsx")).not.toContain("onExpand");
  const chatMarkdown = source("../../components/ChatMarkdown.tsx");
  const video = chatMarkdown.slice(chatMarkdown.indexOf("function ChatMarkdownVideo("));
  expect(video.slice(0, video.indexOf("\n}\n"))).not.toContain("onExpand");
});
