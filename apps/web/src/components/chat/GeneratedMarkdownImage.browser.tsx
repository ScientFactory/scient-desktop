// FILE: GeneratedMarkdownImage.browser.tsx
// Purpose: Verifies generated-image download failures stay on the owning image.

import "../../index.css";

import { page } from "vitest/browser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const downloadUrlAsBlob = vi.hoisted(() => vi.fn());

vi.mock("~/lib/browserDownload", () => ({ downloadUrlAsBlob }));

import { GeneratedMarkdownImage } from "./GeneratedMarkdownImage";

describe("GeneratedMarkdownImage download feedback", () => {
  beforeEach(() => {
    downloadUrlAsBlob.mockReset();
  });

  it("renders a rejected download inline on the generated image", async () => {
    downloadUrlAsBlob.mockRejectedValue(new Error("The generated file is unavailable."));
    await render(
      <GeneratedMarkdownImage src="/tmp/generated.png" alt="Generated chart" cwd="/tmp" />,
    );

    await page.getByRole("link", { name: "Download generated image" }).click();

    await expect
      .element(page.getByRole("alert"))
      .toHaveTextContent("The generated file is unavailable.");
  });
});
