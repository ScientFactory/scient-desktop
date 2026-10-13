// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { MarkdownCodeBlock } from "./MarkdownCodeBlock";

beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

it("holds a loading block's code unseen but readable, for screen readers and Copy message", () => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() =>
    root.render(
      <MarkdownCodeBlock code={"const a = 1;\n"} language="ts" fenceTitle={null} theme="light" />,
    ),
  );
  // The highlighter has not loaded yet: the plain code holds the block.
  const placeholder = host.querySelector(".invisible");
  expect(placeholder?.textContent).toContain("const a = 1;");
  expect(placeholder?.closest("[aria-hidden]")).toBeNull();
  act(() => root.unmount());
});
