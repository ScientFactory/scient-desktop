import "../../index.css";
import { render as _fixtureRender, type Screen, act } from "../../../test/render";
import {
  ArtifactAuthority,
  ArtifactId,
  ArtifactRevisionId,
  BindingGeneration,
  LogicalDocumentKey,
  PdfSourceDescriptor,
  type PdfSourceActions,
  type PdfSourceResolution,
  type PdfSourceResolver,
} from "@scientfactory/document-artifacts";
import { StrictMode } from "react";
import { page } from "vite-plus/test/browser";

import { expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  readPresentation: (): ReturnType<typeof presentation> | null => null,
}));

vi.mock("./useScientPdfReader", () => ({
  useScientPdfReader: () => ({
    state: {
      error: null,
      findCount: { current: 0, total: 0 },
      findPhase: "idle",
      loadedSourceUrl: mocks.readPresentation()?.sourceUrl,
      outline: [],
      page: 1,
      pageCount: 1,
      passwordReason: null,
      phase: "ready",
      progress: 1,
      rotation: 0,
      scale: 1,
      scanned: false,
      updateError: null,
      updating: false,
    },
    presentation: mocks.readPresentation(),
    presentationCurrent: true,
    runtimeRef: { current: null },
    closeSearch: vi.fn(),
    findAgain: vi.fn(),
    goToDestination: vi.fn(),
    goToPage: vi.fn(),
    goToSyncPoint: vi.fn(),
    prepareSearch: vi.fn(),
    rotate: vi.fn(),
    setSearchQuery: vi.fn(),
    setZoom: vi.fn(),
    setZoomMode: vi.fn(),
    submitPassword: vi.fn(),
    syncPointFromClient: vi.fn(() => null),
  }),
}));
vi.mock("./pdfCopyAnalytics", () => ({
  observePdfCopy: (_environmentId: string, run: () => Promise<unknown>) => run(),
}));
vi.mock("./pdfSaveCopyNotification", () => ({
  announcePdfSaveCopyResult: () => ({ refreshSource: false }),
}));

import { ScientPdfReader } from "./ScientPdfReader";
import { pdfReaderSessionDocumentKey } from "./pdfReaderSessionStore";

const authority = ArtifactAuthority.make("presentation-action-environment");
const logicalDocumentKey = LogicalDocumentKey.make("presentation-action-document");
const documentKey = pdfReaderSessionDocumentKey({ authority, logicalDocumentKey });
const refreshA = vi.fn();
const refreshB = vi.fn();

function source(revision: string) {
  return PdfSourceDescriptor.make({
    _tag: "generated-pdf",
    authority,
    logicalDocumentKey,
    title: "Presented report",
    fileName: `Presented report ${revision}.pdf`,
    capabilities: { canSaveCopy: true, canRevealSource: false },
    artifactId: ArtifactId.make("presentation-action-artifact"),
    revisionId: ArtifactRevisionId.make(revision),
    bindingGeneration: BindingGeneration.make(revision === "revision-a" ? 1 : 2),
    bindingStatus: "current",
    staleReason: null,
  });
}

const sourceA = source("revision-a");
const sourceB = source("revision-b");
const assetA = {
  _tag: "Success",
  url: "https://assets.scient.test/revision-a.pdf",
  expiresAt: 1_000,
  refresh: refreshA,
} satisfies PdfSourceResolution;
const assetB = {
  _tag: "Success",
  url: "https://assets.scient.test/revision-b.pdf",
  expiresAt: 2_000,
  refresh: refreshB,
} satisfies PdfSourceResolution;
const failedB = { _tag: "Failure", refresh: refreshB } satisfies PdfSourceResolution;
let currentAsset: PdfSourceResolution = assetA;
const resolver: PdfSourceResolver = { useResolve: () => currentAsset };
const saveCopy = vi.fn<PdfSourceActions["saveCopy"]>();
const actions: PdfSourceActions = { saveCopy };

function presentation(revisionId: string, sourceUrl: string) {
  return {
    container: document.createElement("div"),
    documentKey,
    revisionId,
    sourceUrl,
  };
}

async function render(
  _fixture: _Fixture,
  requestedSource: PdfSourceDescriptor,
  asset: PdfSourceResolution,
  painted: ReturnType<typeof presentation>,
) {
  currentAsset = asset;
  _fixture.publishPresentation(painted);
  await act(
    async () =>
      await _fixture.root0.rerender(
        <StrictMode>
          <ScientPdfReader source={requestedSource} resolver={resolver} actions={actions} />
        </StrictMode>,
      ),
  );
}

async function savePaintedCopy(_fixture: _Fixture) {
  await _fixture.root0.getByRole("button", { name: "More PDF actions" }).click();
  await page.getByRole("menuitem", { name: "Save a copy" }).click();
}

async function _setupFixture0(_fixture: _Fixture) {
  _fixture.mount = document.createElement("div");
  document.body.append(_fixture.mount);
  _fixture.root0 = _fixture.stack.use(
    await _fixtureRender(null, { container: _fixture.mount, router: false }),
  );
  _fixture.publishPresentation(null);
  mocks.readPresentation = _fixture.readPresentation;
  _fixture.stack.defer(() => {
    mocks.readPresentation = () => null;
  });
  currentAsset = assetA;
  saveCopy.mockReset().mockResolvedValue({ _tag: "cancelled" });
  refreshA.mockReset();
  refreshB.mockReset();
}

async function _cleanupFixture1(_fixture: _Fixture) {
  await act(async () => await _fixture.root0.unmount());
  _fixture.mount.remove();
}

it("saves the painted PDF while a newer source stages, is held, or fails", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const paintedA = presentation("revision-a", assetA.url);
  await render(_fixture, sourceA, assetA, paintedA);
  await savePaintedCopy(_fixture);

  // B is requested and may stage or remain held, but A still owns the canvas.
  await render(_fixture, sourceB, assetB, paintedA);
  await savePaintedCopy(_fixture);
  await render(_fixture, sourceB, assetB, paintedA);
  await savePaintedCopy(_fixture);

  // Resolver failure also keeps A's descriptor and authorization paired together.
  await render(_fixture, sourceB, failedB, paintedA);
  await savePaintedCopy(_fixture);
  expect(saveCopy.mock.calls.slice(0, 4)).toEqual([
    [sourceA, { url: assetA.url, expiresAt: assetA.expiresAt, refresh: refreshA }],
    [sourceA, { url: assetA.url, expiresAt: assetA.expiresAt, refresh: refreshA }],
    [sourceA, { url: assetA.url, expiresAt: assetA.expiresAt, refresh: refreshA }],
    [sourceA, { url: assetA.url, expiresAt: assetA.expiresAt, refresh: refreshA }],
  ]);

  // The action switches only with the atomic publication of B.
  await render(_fixture, sourceB, assetB, presentation("revision-b", assetB.url));
  await savePaintedCopy(_fixture);
  expect(saveCopy).toHaveBeenLastCalledWith(sourceB, {
    url: assetB.url,
    expiresAt: assetB.expiresAt,
    refresh: refreshB,
  });
});

it("keeps a stale notice for generated PDFs outside the LaTeX header", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  if (sourceA._tag !== "generated-pdf") throw new Error("Expected a generated fixture");
  await render(
    _fixture,
    { ...sourceA, bindingStatus: "stale" },
    assetA,
    presentation("revision-a", assetA.url),
  );
  expect(_fixture.mount.textContent).toContain(
    "PDF is out of date. Showing the previous revision.",
  );
});

function _createFixture() {
  let painted: ReturnType<typeof presentation> | null = null;
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    readPresentation: () => painted,
    publishPresentation(next: typeof painted) {
      painted = next;
    },
    mount: undefined! as HTMLDivElement,
    stack,
    cleanup,
    root0: undefined! as Screen,
    async [Symbol.asyncDispose]() {
      try {
        await cleanup.disposeAsync();
      } finally {
        await stack.disposeAsync();
      }
    },
  };
}
type _Fixture = ReturnType<typeof _createFixture>;
