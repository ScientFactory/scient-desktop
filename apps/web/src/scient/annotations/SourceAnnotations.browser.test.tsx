import { PDF_TEXT_PROFILE } from "@scientfactory/document-artifacts";
import {
  EnvironmentId,
  type ScientAnnotationMutationRequest,
  type ScientPdfAnnotation,
  type ScientSourceDetailResult,
} from "@t3tools/contracts";
import { PDFDocument, PDFName } from "pdf-lib";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import "~/index.css";

import type * as AssetUrls from "~/assets/assetUrls";
import { randomUUID } from "~/lib/utils";

import { render } from "../../../test/render";
import {
  clearPdfReveals,
  pdfRevealDocumentKey,
  pendingPdfReveal,
} from "../pdf/anchors/pdfRevealRequests";
import { workspacePdfSource } from "../pdf/pdfSource";
import { SourceAnnotations } from "./SourceAnnotations";

const client = vi.hoisted(() => ({
  read: vi.fn(),
  readSource: vi.fn(),
  mutate: vi.fn(),
}));
vi.mock("../sources/sourcesCommands", () => ({ useCanChangeLibrary: () => true }));
vi.mock("./client", () => ({
  readDocumentAnnotations: client.read,
  readSourceAnnotations: client.readSource,
  mutateAnnotation: client.mutate,
}));
const assets = vi.hoisted(() => ({ url: vi.fn<() => Promise<string | null>>() }));
vi.mock("~/assets/assetUrls", async (importOriginal) => ({
  ...(await importOriginal<typeof AssetUrls>()),
  useAssetUrlRefresh: () => assets.url,
}));

const environmentId = EnvironmentId.make("environment-source-annotations");
const sha256 = "d".repeat(64);
const attachment = {
  attachmentId: "pdf_1",
  kind: "pdf" as const,
  fileName: "sleep.pdf",
  mediaType: "application/pdf" as const,
  sha256,
  byteLength: 2_000,
  relativePath: `files/sha256/dd/${sha256}.pdf`,
  importedAt: "2026-11-10T12:00:00.000Z",
};

function annotation(id: string, page: number, quote: string, createdBy: "user" | "agent") {
  return {
    annotationId: id,
    revision: 1,
    anchor: {
      extractor: { profile: PDF_TEXT_PROFILE, version: "1" },
      selector: {
        type: "text",
        pages: [
          {
            page,
            viewBox: [0, 0, 612, 792],
            rotation: 0,
            userUnit: 1,
            pageTextHash: "0".repeat(64),
            start: 0,
            end: quote.length,
            quote,
            prefix: "",
            suffix: "",
          },
        ],
      },
    },
    highlighted: true,
    note: createdBy === "agent" ? "Main result" : "",
    createdAt: "t",
    createdBy,
    updatedAt: "t",
    updatedBy: createdBy,
    deletedAt: null,
  } satisfies ScientPdfAnnotation;
}

function setup() {
  clearPdfReveals();
  const root = `/project-${randomUUID()}`;
  const later = annotation("ann_pagefour1", 4, "Deep sleep doubled recall", "agent");
  const earlier = annotation("ann_pagetwo01", 2, "We studied sleep in mice", "user");
  client.readSource.mockReset().mockResolvedValue({
    attachments: [
      {
        attachmentId: "pdf_1",
        material: { sha256, byteLength: 2_000 },
        annotations: [later, earlier],
      },
    ],
  });
  client.mutate
    .mockReset()
    .mockImplementation(async (_env, request: ScientAnnotationMutationRequest) => ({
      outcome: "removed",
      annotation: {
        ...later,
        revision: 2,
        deletedAt: "t2",
        annotationId: request.command.annotationId,
      },
    }));
  const onOpenPdf = vi.fn();
  const record = {
    sourceId: "source_sleep",
    attachments: [attachment],
  } as unknown as ScientSourceDetailResult;
  return { root, onOpenPdf, record, later };
}

describe("Source highlights and notes", () => {
  it("lists passages in reading order and opens the PDF at the one chosen", async () => {
    const { root, onOpenPdf, record, later } = setup();
    await using _screen = await render(
      <SourceAnnotations
        environmentId={environmentId}
        root={root}
        record={record}
        onOpenPdf={onOpenPdf}
      />,
    );
    const first = page.getByRole("button", { name: /We studied sleep in mice/ });
    await expect.element(first).toBeVisible();
    const rows = [...document.querySelectorAll("li")].map((row) => row.textContent);
    expect(rows[0]).toContain("Page 2");
    expect(rows[1]).toContain("Main result");
    expect(rows[1]).toContain("Page 4 · Added by an agent");

    await userEvent.click(page.getByRole("button", { name: /Deep sleep doubled recall/ }));
    expect(onOpenPdf).toHaveBeenCalledWith({
      sourceId: "source_sleep",
      attachmentId: "pdf_1",
      fileName: "sleep.pdf",
    });
    // The key the Sources PDF reader claims: the attachment's path under .scient/sources.
    const key = pdfRevealDocumentKey(
      workspacePdfSource({
        environmentId,
        fileName: "sleep.pdf",
        workspaceRoot: root,
        relativePath: `.scient/sources/${attachment.relativePath}`,
      }),
    );
    const reveal = pendingPdfReveal(key);
    expect(reveal && "target" in reveal ? reveal.target.selector : null).toEqual(
      later.anchor.selector,
    );
  });

  it("removes a passage from the list by its hash, without a path", async () => {
    const { root, onOpenPdf, record } = setup();
    await using _screen = await render(
      <SourceAnnotations
        environmentId={environmentId}
        root={root}
        record={record}
        onOpenPdf={onOpenPdf}
      />,
    );
    await expect.element(page.getByRole("button", { name: /Deep sleep/ })).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Remove" }).nth(1));
    expect(client.mutate.mock.calls[0]![1]).toEqual({
      root,
      material: { sha256, byteLength: 2_000 },
      command: { action: "remove", annotationId: "ann_pagefour1", expectedRevision: 1 },
    });
    await expect.element(page.getByRole("button", { name: /Deep sleep/ })).not.toBeInTheDocument();
  });

  it("lists Zotero's highlights it could not place, and one removed leaves the list", async () => {
    const { root, onOpenPdf, record } = setup();
    const kept = {
      annotationId: "ann_zotero_ABCD2345",
      revision: 1,
      kind: "highlight" as const,
      page: 3,
      quote: "Sleep spindles rose",
      comment: "Check the figure",
      createdAt: "2024-01-24T04:36:20Z",
      deletedAt: null,
    };
    const listed = (unplaced: ReadonlyArray<typeof kept>) => ({
      attachments: [
        {
          attachmentId: "pdf_1",
          material: { sha256, byteLength: 2_000 },
          annotations: [],
          unplaced,
        },
      ],
    });
    // The server's list: the entry leaves it once removed.
    let onServer = [kept];
    client.readSource.mockImplementation(async () => listed(onServer));
    client.mutate.mockImplementation(async () => {
      onServer = [];
      const removed = { ...kept, revision: 2, deletedAt: "2026-11-15T10:00:00.000Z" };
      return { outcome: "removed", annotation: null, unplaced: removed };
    });
    await using _screen = await render(
      <SourceAnnotations
        environmentId={environmentId}
        root={root}
        record={record}
        onOpenPdf={onOpenPdf}
      />,
    );

    const row = page.getByRole("button", { name: /Sleep spindles rose/ });
    await expect.element(row).toBeVisible();
    const [text] = [...document.querySelectorAll("li")].map((entry) => entry.textContent);
    expect(text).toContain("Check the figure");
    expect(text).toContain("Page 3");
    await userEvent.click(page.getByRole("button", { name: "Remove" }));

    expect(client.mutate.mock.calls[0]![1]).toMatchObject({
      command: { action: "remove", annotationId: "ann_zotero_ABCD2345", expectedRevision: 1 },
    });
    await expect.element(row).not.toBeInTheDocument();
  });

  it("cites the printed page of a passage quoted from the list", async () => {
    const { root, onOpenPdf, record } = setup();
    // A journal article whose pages are printed from 1121: PDF page 4 is page 1124.
    const journal = await PDFDocument.create();
    for (let index = 0; index < 5; index += 1) journal.addPage([612, 792]);
    journal.catalog.set(
      PDFName.of("PageLabels"),
      journal.context.obj({ Nums: [0, { S: "D", St: 1121 }] }),
    );
    const url = URL.createObjectURL(
      new Blob([new Uint8Array(await journal.save())], { type: "application/pdf" }),
    );
    using _url = { [Symbol.dispose]: () => URL.revokeObjectURL(url) };
    assets.url.mockReset().mockResolvedValue(url);
    using copied = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    await using _screen = await render(
      <SourceAnnotations
        environmentId={environmentId}
        root={root}
        record={{ ...record, citationKey: "smith2024sleep" }}
        onOpenPdf={onOpenPdf}
      />,
    );
    await expect.element(page.getByRole("button", { name: /Deep sleep/ })).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Quote in my document" }).nth(1));
    await vi.waitFor(() => expect(copied).toHaveBeenCalledTimes(1));
    expect(copied.mock.calls[0]![0]).toBe("> Deep sleep doubled recall [@smith2024sleep, p. 1124]");
  });
});
