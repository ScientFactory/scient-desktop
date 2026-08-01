// FILE: ExpandedImageDialog.browser.tsx
// Purpose: Verifies duplicate-source navigation resets state owned by the expanded image frame.

import "../../index.css";

import { page, userEvent } from "vitest/browser";
import { useRef, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const downloadUrlAsBlob = vi.hoisted(() => vi.fn());

vi.mock("~/lib/browserDownload", () => ({ downloadUrlAsBlob }));

import { ExpandedImageDialog } from "./ExpandedImageDialog";
import { ChatImageAttachmentGallery } from "./ChatImageAttachmentGallery";
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

function KeyboardDialogHarness() {
  const [preview, setPreview] = useState<ExpandedImagePreview | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setPreview({ images, index: 0, returnFocus: triggerRef.current })}
      >
        Open preview
      </button>
      <ExpandedImageDialog
        preview={preview}
        onOpenChange={(open) => {
          if (!open) setPreview(null);
        }}
        onNavigate={(direction) =>
          setPreview((current) =>
            current
              ? {
                  ...current,
                  index:
                    (current.index + direction + current.images.length) % current.images.length,
                }
              : null,
          )
        }
        fallbackFocusRef={triggerRef}
      />
    </>
  );
}

function GallerySourceTransitionHarness() {
  const [previewUrl, setPreviewUrl] = useState("/attachments/source-a");

  return (
    <>
      <button type="button" onClick={() => setPreviewUrl("/attachments/source-a")}>
        Use source A
      </button>
      <button type="button" onClick={() => setPreviewUrl("/attachments/source-b")}>
        Use source B
      </button>
      <ChatImageAttachmentGallery
        images={[{ id: "capture", name: "capture.png", previewUrl }]}
        onImageExpand={() => {}}
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

  it("reserves a bounded gallery row for a failed thumbnail download", async () => {
    const longName = `${"capture".repeat(18)}.png`;
    const longFailure = "unavailable".repeat(24);
    downloadUrlAsBlob.mockRejectedValue(new Error(longFailure));
    const screen = await render(
      <div className="w-[260px]">
        <ChatImageAttachmentGallery
          images={[{ id: "capture", name: longName, previewUrl: "/attachments/capture" }]}
          onImageExpand={() => {}}
        />
        <p>Following transcript content</p>
      </div>,
    );

    try {
      await page.getByRole("link", { name: `Download ${longName}` }).click();
      const alert = page.getByText(`Could not download ${longName}: ${longFailure}`, {
        exact: true,
      });
      const following = page.getByText("Following transcript content");
      await expect.element(alert).toBeVisible();
      await expect.element(following).toBeVisible();

      const alertElement = await alert.element();
      const alertRect = alertElement.getBoundingClientRect();
      const followingRect = (await following.element()).getBoundingClientRect();
      expect(alertRect.width).toBeLessThanOrEqual(240);
      expect(alertElement.scrollWidth).toBeLessThanOrEqual(alertElement.clientWidth + 1);
      expect(alertRect.bottom).toBeLessThanOrEqual(followingRect.top + 1);
    } finally {
      await screen.unmount();
    }
  });

  it("does not revive an old gallery action error after an A to B to A source transition", async () => {
    downloadUrlAsBlob.mockRejectedValue(new Error("The first source failed."));
    const screen = await render(<GallerySourceTransitionHarness />);

    try {
      await page.getByRole("link", { name: "Download capture.png" }).click();
      const staleError = page.getByText(
        "Could not download capture.png: The first source failed.",
        { exact: true },
      );
      await expect.element(staleError).toBeVisible();

      await page.getByRole("button", { name: "Use source B" }).click();
      await expect.element(staleError).not.toBeInTheDocument();
      await page.getByRole("button", { name: "Use source A" }).click();
      await expect.element(staleError).not.toBeInTheDocument();
    } finally {
      await screen.unmount();
    }
  });

  it("supports arrow navigation, focus trapping, Escape, and trigger focus return", async () => {
    const screen = await render(<KeyboardDialogHarness />);
    const trigger = page.getByRole("button", { name: "Open preview" });

    try {
      await trigger.click();
      const dialog = page.getByRole("dialog");
      await expect.element(dialog).toBeVisible();
      await expect.element(page.getByRole("heading", { name: "First duplicate" })).toBeVisible();

      await userEvent.keyboard("{ArrowRight}");
      await expect.element(page.getByRole("heading", { name: "Second duplicate" })).toBeVisible();
      await userEvent.keyboard("{ArrowLeft}");
      await expect.element(page.getByRole("heading", { name: "First duplicate" })).toBeVisible();

      for (let index = 0; index < 6; index += 1) {
        await userEvent.keyboard("{Tab}");
        expect((await dialog.element()).contains(document.activeElement)).toBe(true);
      }

      await userEvent.keyboard("{Escape}");
      await expect.element(dialog).not.toBeInTheDocument();
      expect(document.activeElement).toBe(await trigger.element());
    } finally {
      await screen.unmount();
    }
  });
});
