import "../../index.css";
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
      await screen.getByRole("button", { name: "Next page" }).click();
      await expect.element(screen.getByText("Page 2 of 3")).toBeVisible();
      await expect.element(screen.getByText("2,000–2,007")).toBeVisible();
      expect(screen.getByRole("button", { name: "Previous page" }).element()).toBeEnabled();
    } finally {
      URL.revokeObjectURL(src);
    }
  });

  it("steps channel and Z independently without moving the image", async () => {
    const description =
      '<?xml version="1.0"?><OME xmlns="http://www.openmicroscopy.org/Schemas/OME/2016-06"><Image ID="Image:0"><Pixels ID="Pixels:0" DimensionOrder="XYZCT" Type="uint16" SizeX="4" SizeY="2" SizeZ="3" SizeC="2" SizeT="1"><Channel ID="Channel:0:0" SamplesPerPixel="1"/></Pixels></Image></OME>';
    // Ranges as narrow as "1–8" and as wide as "50,000–50,007", so a plane's text width varies.
    const bytes = await tiffFixture(
      [0, 1, 2, 3, 4, 5].map((page) => ({
        width: 4,
        height: 2,
        bits: 16 as const,
        data: Array.from({ length: 8 }, (_, index) => (page % 2 ? 50_000 : 1) + index),
        ...(page === 0 ? { description } : {}),
      })),
    );
    const src = URL.createObjectURL(new Blob([bytes], { type: "image/tiff" }));
    await using screen = await render(
      <div style={{ display: "flex", flexDirection: "column", width: 420, height: 300 }}>
        <PreviewImageContent src={src} name="stack.ome.tif" />
      </div>,
    );
    try {
      // Measured once the decoded plane has loaded and been sized.
      const imageTop = async () => {
        await vi.waitFor(() =>
          expect(screen.container.querySelector("img")?.style.width).not.toBe(""),
        );
        return screen.container.querySelector("img")!.getBoundingClientRect().top;
      };
      const shownSource = () => screen.container.querySelector("img")?.getAttribute("src");
      const step = async (name: string, expected: string) => {
        const before = shownSource();
        await screen.getByRole("button", { name }).click();
        await expect.element(screen.getByText(expected)).toBeVisible();
        await vi.waitFor(() => expect(shownSource()).not.toBe(before));
      };
      await expect.element(screen.getByText("C 1/2")).toBeVisible();
      await expect.element(screen.getByText("Z 1/3")).toBeVisible();
      await expect.element(screen.getByText("1–8")).toBeVisible();
      const top = await imageTop();
      await step("Next Z slice", "Z 2/3");
      await expect.element(screen.getByText("50,000–50,007")).toBeVisible();
      expect(screen.container.textContent).toContain("C 1/2");
      expect(await imageTop()).toBe(top);
      await step("Next channel", "C 2/2");
      expect(screen.container.textContent).toContain("Z 2/3");
      expect(screen.getByRole("button", { name: "Next channel" }).element()).toBeDisabled();
      expect(await imageTop()).toBe(top);
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
