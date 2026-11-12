import { PDF_TEXT_PROFILE } from "@scientfactory/document-artifacts";
import {
  EnvironmentId,
  type ScientAnnotationMutationRequest,
  type ScientPdfAnnotation,
  type ScientSourceDetailResult,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import "~/index.css";

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
    expect(pendingPdfReveal(key)?.target.selector).toEqual(later.anchor.selector);
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
});
