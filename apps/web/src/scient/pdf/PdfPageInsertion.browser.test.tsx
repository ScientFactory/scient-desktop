import { act, render } from "../../../test/render";
import { page } from "vite-plus/test/browser";
import { expect, it, vi } from "vite-plus/test";

import { PdfPageInsertion } from "./PdfPageInsertion";
import type { PdfEditSession } from "./pdfEditSession";
import type { PdfEditPage } from "./pdfPageEdits";

const importedPage: PdfEditPage = {
  id: "imported:0",
  sourceId: "imported",
  sourceIndex: 0,
  width: 300,
  height: 300,
  rotation: 0,
};

function fakeSession(insertSucceeds = true) {
  let finishLoading!: (pages: readonly PdfEditPage[]) => void;
  const loading = new Promise<readonly PdfEditPage[]>((resolve) => {
    finishLoading = resolve;
  });
  let pages: readonly PdfEditPage[] = [];
  const fake = {
    run: (operation: () => Promise<void>) => operation(),
    getSnapshot: () => ({ frame: { pages, selection: [] } }),
    loadFile: vi.fn(() => loading),
    releaseFile: vi.fn(),
    insert: vi.fn((inserted: readonly PdfEditPage[]) => {
      if (insertSucceeds) pages = inserted;
      return Promise.resolve();
    }),
    blank: vi.fn(() => Promise.resolve()),
  };
  return { session: fake as unknown as PdfEditSession, fake, finishLoading };
}

async function pickPdf(container: HTMLElement) {
  const input = container.querySelector<HTMLInputElement>("input[type=file]")!;
  const transfer = new DataTransfer();
  transfer.items.add(new File(["%PDF-1.4"], "appendix.pdf", { type: "application/pdf" }));
  input.files = transfer.files;
  await act(() => input.dispatchEvent(new Event("change", { bubbles: true })));
}

const renderInsertion = (session: PdfEditSession) =>
  render(
    <PdfPageInsertion
      boundary={1}
      session={session}
      disabled={false}
      ensureReady={() => Promise.resolve(true)}
    />,
    { router: false },
  );

it("releases a picked PDF whose gap control disappears while it loads", async () => {
  const { session, fake, finishLoading } = fakeSession();
  await using screen = await renderInsertion(session);
  await pickPdf(screen.container);
  await vi.waitFor(() => expect(fake.loadFile).toHaveBeenCalledOnce());
  await screen.unmount();
  await act(() => finishLoading([importedPage]));
  await vi.waitFor(() => expect(fake.releaseFile).toHaveBeenCalledWith("imported"));
});

it("releases a picked PDF when its insert form is cancelled, and keeps an inserted one", async () => {
  const cancelled = fakeSession();
  {
    await using screen = await renderInsertion(cancelled.session);
    await pickPdf(screen.container);
    await act(() => cancelled.finishLoading([importedPage]));
    await page.getByRole("button", { name: "Cancel" }).click();
    expect(cancelled.fake.releaseFile).toHaveBeenCalledWith("imported");
  }
  const inserted = fakeSession();
  await using screen = await renderInsertion(inserted.session);
  await pickPdf(screen.container);
  await act(() => inserted.finishLoading([importedPage]));
  await page.getByRole("button", { name: "Insert" }).click();
  await vi.waitFor(() => expect(inserted.fake.insert).toHaveBeenCalledWith([importedPage], 1));
  await screen.unmount();
  expect(inserted.fake.releaseFile).not.toHaveBeenCalled();
});

it("releases a picked PDF whose insertion fails", async () => {
  const failing = fakeSession(false);
  await using screen = await renderInsertion(failing.session);
  await pickPdf(screen.container);
  await act(() => failing.finishLoading([importedPage]));
  await page.getByRole("button", { name: "Insert" }).click();
  await vi.waitFor(() => expect(failing.fake.releaseFile).toHaveBeenCalledWith("imported"));
});
