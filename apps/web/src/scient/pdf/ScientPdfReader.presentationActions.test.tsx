// @vitest-environment happy-dom
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
import { act, StrictMode, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  presentation: null as {
    container: HTMLDivElement;
    documentKey: string;
    revisionId: string | null;
    sourceUrl: string;
  } | null,
}));

vi.mock("./useScientPdfReader", () => ({
  useScientPdfReader: () => ({
    state: {
      error: null,
      findCount: { current: 0, total: 0 },
      findPhase: "idle",
      loadedSourceUrl: mocks.presentation?.sourceUrl,
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
    presentation: mocks.presentation,
    runtimeRef: { current: null },
    closeSearch: vi.fn(),
    findAgain: vi.fn(),
    goToDestination: vi.fn(),
    goToPage: vi.fn(),
    goToSyncPoint: vi.fn(),
    prepareSearch: vi.fn(),
    registerAnchorProvider: vi.fn(),
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
vi.mock("../presentation/ScientTooltip", () => ({
  ScientTooltip: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("~/components/ui/menu", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({
    children,
    disabled,
    onClick,
  }: {
    children: ReactNode;
    disabled?: boolean;
    onClick?: () => void;
  }) => (
    <button type="button" disabled={disabled} onClick={onClick}>
      {children}
    </button>
  ),
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuTrigger: ({ children, ...props }: ComponentProps<"button">) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
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
let mount: HTMLDivElement;
let root: Root;

function presentation(revisionId: string, sourceUrl: string) {
  return {
    container: document.createElement("div"),
    documentKey,
    revisionId,
    sourceUrl,
  };
}

async function render(
  requestedSource: PdfSourceDescriptor,
  asset: PdfSourceResolution,
  painted: ReturnType<typeof presentation>,
) {
  currentAsset = asset;
  mocks.presentation = painted;
  await act(() =>
    root.render(
      <StrictMode>
        <ScientPdfReader source={requestedSource} resolver={resolver} actions={actions} />
      </StrictMode>,
    ),
  );
}

async function savePaintedCopy() {
  const button = Array.from(mount.querySelectorAll("button")).find((candidate) =>
    candidate.textContent?.includes("Save a copy"),
  );
  expect(button).toBeDefined();
  await act(async () => {
    button!.click();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mount = document.createElement("div");
  document.body.append(mount);
  root = createRoot(mount);
  mocks.presentation = null;
  currentAsset = assetA;
  saveCopy.mockReset().mockResolvedValue({ _tag: "cancelled" });
  refreshA.mockReset();
  refreshB.mockReset();
});

afterEach(async () => {
  await act(() => root.unmount());
  mount.remove();
  vi.unstubAllGlobals();
});

it("saves the painted PDF while a newer source stages, is held, or fails", async () => {
  const paintedA = presentation("revision-a", assetA.url);
  await render(sourceA, assetA, paintedA);
  await savePaintedCopy();

  // B is requested and may stage or remain held, but A still owns the canvas.
  await render(sourceB, assetB, paintedA);
  await savePaintedCopy();
  await render(sourceB, assetB, paintedA);
  await savePaintedCopy();

  // Resolver failure also keeps A's descriptor and authorization paired together.
  await render(sourceB, failedB, paintedA);
  await savePaintedCopy();
  expect(saveCopy.mock.calls.slice(0, 4)).toEqual([
    [sourceA, { url: assetA.url, expiresAt: assetA.expiresAt, refresh: refreshA }],
    [sourceA, { url: assetA.url, expiresAt: assetA.expiresAt, refresh: refreshA }],
    [sourceA, { url: assetA.url, expiresAt: assetA.expiresAt, refresh: refreshA }],
    [sourceA, { url: assetA.url, expiresAt: assetA.expiresAt, refresh: refreshA }],
  ]);

  // The action switches only with the atomic publication of B.
  await render(sourceB, assetB, presentation("revision-b", assetB.url));
  await savePaintedCopy();
  expect(saveCopy).toHaveBeenLastCalledWith(sourceB, {
    url: assetB.url,
    expiresAt: assetB.expiresAt,
    refresh: refreshB,
  });
});
