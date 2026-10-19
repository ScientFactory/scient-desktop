// @effect-diagnostics nodeBuiltinImport:off -- architectural seam reads source text.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { expect, it } from "vite-plus/test";

const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const chatViewSource = NodeFS.readFileSync(
  NodePath.join(here, "../../components/ChatView.tsx"),
  "utf8",
);

// The hook's own tests cover a background window and a completion whose answer has not loaded;
// they only protect the chat if no other writer in the chat view marks the thread visited.
it("leaves useAcknowledgeAnswer as the chat view's only visit writer", () => {
  expect(chatViewSource.match(/\buseAcknowledgeAnswer\(/g)).toHaveLength(1);
  expect(chatViewSource).not.toMatch(/threadEnvironment\.visit\b/);
  expect(chatViewSource).not.toMatch(/\bmarkThreadVisited\b/);
  expect(chatViewSource).not.toMatch(/<ThreadVisitWatermark\b/);
});
