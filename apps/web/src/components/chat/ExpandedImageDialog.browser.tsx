// FILE: ExpandedImageDialog.browser.tsx
// Purpose: Verifies duplicate-source navigation resets state owned by the expanded image frame.

import "../../index.css";

import { page } from "vitest/browser";
import { useRef, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const downloadUrlAsBlob = vi.hoisted(() => vi.fn());

vi.mock("~/lib/browserDownload", () => ({ downloadUrlAsBlob }));

import { ExpandedImageDialog } from "./ExpandedImageDialog";
import type { ExpandedImagePreview } from "./ExpandedImagePreview";

const duplicateUrl = "/attachments/duplicate.png";

const images: ExpandedImagePreview["images"] = ["First duplicate", "Second duplicate"].map(
  (name) => ({
    src: duplicateUrl,
    name,
    source: {
      kind: "attachment",
      previewUrl: duplicateUrl,
      downloadUrl: duplicateUrl,
      name,
    },
  }),
);

function DuplicateSourceDialogHarness() {
  const [index, setIndex] = useState(0);
  const fallbackFocusRef = useRef<HTMLButtonElement>(null);

  return (
    <>
      <button ref={fallbackFocusRef} type="button">
        Fallback focus
      </button>
      <ExpandedImageDialog
        preview={{ images, index }}
        onOpenChange={() => {}}
        onNavigate={(direction) =>
          setIndex((current) => (current + direction + images.length) % images.length)
        }
        fallbackFocusRef={fallbackFocusRef}
      />
    </>
  );
}

describe("ExpandedImageDialog duplicate-source navigation", () => {
  beforeEach(() => {
    downloadUrlAsBlob.mockReset();
  });

  it("does not retain the prior item's action error when duplicate URLs are navigated", async () => {
    downloadUrlAsBlob.mockRejectedValue(new Error("The first download failed."));
    const screen = await render(<DuplicateSourceDialogHarness />);

    try {
      await page.getByRole("link", { name: "Download First duplicate" }).click();
      await expect
        .element(page.getByText("Could not download image: The first download failed."))
        .toBeVisible();

      await page.getByRole("button", { name: "Next image" }).click();

      await expect
        .element(page.getByRole("link", { name: "Download Second duplicate" }))
        .toBeInTheDocument();
      await expect
        .element(page.getByText("Could not download image: The first download failed."))
        .not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("ignores a late download failure from the image shown before navigation", async () => {
    let rejectDownload: ((reason: Error) => void) | undefined;
    downloadUrlAsBlob.mockImplementation(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectDownload = reject;
        }),
    );
    const screen = await render(<DuplicateSourceDialogHarness />);

    try {
      await page.getByRole("link", { name: "Download First duplicate" }).click();
      await page.getByRole("button", { name: "Next image" }).click();
      rejectDownload?.(new Error("The earlier download failed."));

      await expect
        .element(page.getByRole("link", { name: "Download Second duplicate" }))
        .toBeInTheDocument();
      await expect
        .element(page.getByText("Could not download image: The earlier download failed."))
        .not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });
});
