import { render } from "../../../test/render";
import { tiffFixture } from "../../../test/tiffFixture";

import { describe, expect, it, vi } from "vite-plus/test";

import PreviewImageContent from "./PreviewImageContent";

// SCIENT-FORK:START
describe("Scient TIFF preview", () => {
  const stack = () =>
    tiffFixture(
      [1, 2, 3].map((page) => ({
        width: 4,
        height: 2,
        bits: 16 as const,
        data: Array.from({ length: 8 }, (_, index) => page * 1_000 + index),
      })),
    );

  async function open(bytes: ArrayBuffer, onError = vi.fn()) {
    const src = URL.createObjectURL(new Blob([bytes], { type: "image/tiff" }));
    const screen = await render(
      <PreviewImageContent src={src} name="stack.tif" onError={onError} />,
    );
    return { screen, src, onError };
  }

  it("shows the size, value range and plane, and steps to the next plane", async () => {
    const { screen, src } = await open(await stack());
    await using _screen = screen;
    try {
      await expect.element(screen.getByText("Page 1 of 3")).toBeVisible();
      await expect.element(screen.getByText("1,000–1,007")).toBeVisible();
      expect(screen.container.textContent).toContain("4 × 2");
      expect(screen.container.textContent).toContain("16-bit");
      const image = screen.container.querySelector("img");
      expect(image?.getAttribute("src")).toMatch(/^blob:/u);
      await screen.getByRole("button", { name: "Next plane" }).click();
      await expect.element(screen.getByText("Page 2 of 3")).toBeVisible();
      await expect.element(screen.getByText("2,000–2,007")).toBeVisible();
      expect(screen.getByRole("button", { name: "Previous plane" }).element()).toBeEnabled();
    } finally {
      URL.revokeObjectURL(src);
    }
  });

  it("explains a TIFF it cannot read without asking the viewer to reload the file", async () => {
    const bytes = await stack();
    const view = new DataView(bytes);
    view.setUint16(view.getUint32(4, true) + 2 + 3 * 12 + 8, 34_712, true);
    const { screen, src, onError } = await open(bytes);
    await using _screen = screen;
    try {
      await expect.element(screen.getByText("Couldn't display this image")).toBeVisible();
      await screen.getByRole("button", { name: /details/iu }).click();
      await expect.element(screen.getByText(/compression \(JPEG 2000\)/u)).toBeVisible();
      expect(onError).not.toHaveBeenCalled();
    } finally {
      URL.revokeObjectURL(src);
    }
  });

  it("hands a file that can no longer be loaded back to the viewer", async () => {
    const src = URL.createObjectURL(new Blob([await stack()]));
    URL.revokeObjectURL(src);
    const onError = vi.fn();
    await using screen = await render(
      <PreviewImageContent src={src} name="stack.tif" onError={onError} />,
    );
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    await expect.element(screen.getByText("Couldn't display this image")).toBeVisible();
  });
});
// SCIENT-FORK:END
