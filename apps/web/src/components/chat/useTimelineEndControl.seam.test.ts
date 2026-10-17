// @effect-diagnostics nodeBuiltinImport:off -- Static audit for ChatView's end-control mount.
import * as NodeFS from "node:fs";

import { expect, it } from "vite-plus/test";

const chatViewSource = NodeFS.readFileSync(new URL("../ChatView.tsx", import.meta.url), "utf8");

// The timeline never pins to its end (maintainScrollAtEnd stays off), so
// ChatView must hand every end report to the end-control hook. Upstream's
// handler swallows "left the end" while its list pins itself; restoring it
// hides Scroll to end while an answer grows below the screen.
it("passes the timeline's end reports straight to the end control", () => {
  expect(chatViewSource).toContain("const onIsAtEndChange = onEndControlIsAtEndChange;");
  expect(chatViewSource).toContain("onIsAtEndChange={onIsAtEndChange}");
  expect(chatViewSource).not.toContain("resetEndControlForThread(true)");
});
