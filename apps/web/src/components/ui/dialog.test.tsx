// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { Dialog, DialogPortal, DialogViewport } from "./dialog";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

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
