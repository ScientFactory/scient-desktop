import { describe, expect, it } from "vite-plus/test";
import { render } from "../../../test/render";

import { Dialog, DialogPortal, DialogViewport } from "./dialog";

describe("dialog viewport", () => {
  it("stays interactive when it overlaps an Electron drag region", async () => {
    await using _screen = await render(
      <Dialog open>
        <DialogPortal>
          <DialogViewport />
        </DialogPortal>
      </Dialog>,
    );

    const viewport = document.querySelector('[data-slot="dialog-viewport"]');
    expect(viewport?.classList.contains("[-webkit-app-region:no-drag]")).toBe(true);
  });
});
