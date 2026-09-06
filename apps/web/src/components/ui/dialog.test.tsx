// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterAll, afterEach, describe, expect, it, vi } from "vite-plus/test";

import { Dialog, DialogPortal, DialogViewport } from "./dialog";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
afterAll(() => vi.unstubAllGlobals());

const host = document.createElement("div");
document.body.append(host);
const root = createRoot(host);

afterEach(async () => {
  await act(() => root.render(null));
});

describe("dialog viewport", () => {
  it("stays interactive when it overlaps an Electron drag region", async () => {
    await act(() =>
      root.render(
        <Dialog open>
          <DialogPortal>
            <DialogViewport />
          </DialogPortal>
        </Dialog>,
      ),
    );

    const viewport = document.querySelector('[data-slot="dialog-viewport"]');
    expect(viewport?.classList.contains("[-webkit-app-region:no-drag]")).toBe(true);
  });
});
