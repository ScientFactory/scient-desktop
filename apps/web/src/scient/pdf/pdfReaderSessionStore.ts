import type { StateStorage } from "~/lib/storage";
import { createMemoryStorage } from "~/lib/storage";

import { clampPdfPage, normalizePdfZoom, type PdfSidebarMode } from "./pdfReaderModel";

export const PDF_READER_SESSION_STORAGE_KEY = "scient:pdf-reader-sessions:v1";
export const PDF_READER_SESSION_MAX_DOCUMENTS = 100;

const PDF_READER_SESSION_VERSION = 1;
const PDF_READER_SESSION_WRITE_DELAY_MS = 250;
const MAX_DOCUMENT_KEY_LENGTH = 2_048;
const MAX_PAGE_NUMBER = 10_000_000;
const MAX_PDF_COORDINATE = 10_000_000;
const PDF_ZOOM_MODES = new Set(["auto", "page-actual", "page-fit", "page-height", "page-width"]);
const PDF_SIDEBAR_MODES = new Set<PdfSidebarMode>(["closed", "outline", "thumbnails"]);

export type PdfReaderRotation = 0 | 90 | 180 | 270;

export interface PdfReaderViewport {
  readonly page: number;
  readonly left: number | null;
  readonly top: number | null;
  readonly scaleValue: string;
  readonly rotation: PdfReaderRotation;
}

export interface PdfReaderSession {
  readonly viewport: PdfReaderViewport | null;
  readonly sidebar: PdfSidebarMode;
  readonly updatedAt: number;
}

export interface PdfViewAreaLocation {
  readonly pageNumber?: unknown;
  readonly left?: unknown;
  readonly top?: unknown;
  readonly scale?: unknown;
  readonly rotation?: unknown;
}

export interface PdfViewportRestoreTarget {
  currentPageNumber: number;
  currentScaleValue: string;
  pagesRotation: number;
  scrollPageIntoView: (input: {
    readonly pageNumber: number;
    readonly destArray?: Array<unknown>;
    readonly allowNegativeOffset?: boolean;
    readonly ignoreDestinationZoom?: boolean;
  }) => void;
}

interface PersistedPdfReaderSessions {
  readonly version: 1;
  readonly sessions: Readonly<Record<string, PdfReaderSession>>;
}

interface PdfReaderSessionStoreOptions {
  readonly storage: StateStorage;
  readonly maxDocuments?: number;
  readonly writeDelayMs?: number;
  readonly now?: () => number;
  readonly onStorageError?: (error: unknown) => void;
}

export interface PdfReaderSessionStore {
  readonly get: (documentKey: string) => PdfReaderSession;
  readonly copy: (sourceDocumentKey: string, destinationDocumentKey: string) => void;
  readonly updateViewport: (documentKey: string, viewport: PdfReaderViewport) => void;
  readonly updateSidebar: (documentKey: string, sidebar: PdfSidebarMode) => void;
  readonly flush: () => void;
  readonly dispose: () => void;
}

type PdfReaderSessionTeardownEvent = "beforeunload" | "pagehide";

export function registerPdfReaderSessionTeardownFlush(
  register: (event: PdfReaderSessionTeardownEvent, listener: () => void) => void,
  store: Pick<PdfReaderSessionStore, "flush">,
): void {
  const flush = () => store.flush();
  register("pagehide", flush);
  register("beforeunload", flush);
}

export function pdfReaderSessionDocumentKey(input: {
  readonly authority: string;
  readonly logicalDocumentKey: string;
}): string {
  return JSON.stringify([input.authority, input.logicalDocumentKey]);
}

const EMPTY_SESSION: PdfReaderSession = {
  viewport: null,
  sidebar: "closed",
  updatedAt: 0,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDocumentKey(value: string): boolean {
  return value.length > 0 && value.length <= MAX_DOCUMENT_KEY_LENGTH && !value.includes("\0");
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeCoordinate(value: unknown): number | null | undefined {
  if (value === null) return null;
  const number = finiteNumber(value);
  if (number === null || Math.abs(number) > MAX_PDF_COORDINATE) return undefined;
  return number;
}

function normalizePage(value: unknown): number | null {
  const number = finiteNumber(value);
  if (number === null || !Number.isSafeInteger(number) || number < 1 || number > MAX_PAGE_NUMBER) {
    return null;
  }
  return number;
}

function normalizeRotation(value: unknown): PdfReaderRotation | null {
  return value === 0 || value === 90 || value === 180 || value === 270 ? value : null;
}

function normalizeScaleValue(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const scaleValue = String(value);
  if (PDF_ZOOM_MODES.has(scaleValue)) return scaleValue;
  const numericScale = Number(scaleValue);
  if (!Number.isFinite(numericScale) || numericScale <= 0) return null;
  return String(normalizePdfZoom(numericScale));
}

function normalizeSidebar(value: unknown): PdfSidebarMode | null {
  return typeof value === "string" && PDF_SIDEBAR_MODES.has(value as PdfSidebarMode)
    ? (value as PdfSidebarMode)
    : null;
}

function normalizeTimestamp(value: unknown): number | null {
  const number = finiteNumber(value);
  if (number === null || !Number.isSafeInteger(number) || number < 0) return null;
  return number;
}

export function normalizePdfReaderViewport(value: unknown): PdfReaderViewport | null {
  if (!isRecord(value)) return null;
  const page = normalizePage(value.page);
  const left = normalizeCoordinate(value.left);
  const top = normalizeCoordinate(value.top);
  const scaleValue = normalizeScaleValue(value.scaleValue);
  const rotation = normalizeRotation(value.rotation);
  if (
    page === null ||
    left === undefined ||
    top === undefined ||
    scaleValue === null ||
    rotation === null
  ) {
    return null;
  }
  return { page, left, top, scaleValue, rotation };
}

function normalizeSession(value: unknown): PdfReaderSession | null {
  if (!isRecord(value)) return null;
  const viewport = value.viewport === null ? null : normalizePdfReaderViewport(value.viewport);
  const sidebar = normalizeSidebar(value.sidebar);
  const updatedAt = normalizeTimestamp(value.updatedAt);
  if (viewport === null && value.viewport !== null) return null;
  if (sidebar === null || updatedAt === null) return null;
  return { viewport, sidebar, updatedAt };
}

function pruneSessions(
  sessions: Readonly<Record<string, PdfReaderSession>>,
  maxDocuments: number,
): Record<string, PdfReaderSession> {
  return Object.fromEntries(
    Object.entries(sessions)
      .filter(([documentKey]) => isDocumentKey(documentKey))
      .sort(
        ([leftKey, left], [rightKey, right]) =>
          right.updatedAt - left.updatedAt || leftKey.localeCompare(rightKey),
      )
      .slice(0, maxDocuments),
  );
}

export function decodePdfReaderSessions(
  serialized: string | null,
  maxDocuments = PDF_READER_SESSION_MAX_DOCUMENTS,
): Record<string, PdfReaderSession> {
  if (serialized === null) return {};
  try {
    const parsed: unknown = JSON.parse(serialized);
    if (
      !isRecord(parsed) ||
      parsed.version !== PDF_READER_SESSION_VERSION ||
      !isRecord(parsed.sessions)
    ) {
      return {};
    }
    const sessions = Object.fromEntries(
      Object.entries(parsed.sessions).flatMap(([documentKey, value]) => {
        if (!isDocumentKey(documentKey)) return [];
        const session = normalizeSession(value);
        return session === null ? [] : [[documentKey, session] as const];
      }),
    );
    return pruneSessions(sessions, maxDocuments);
  } catch {
    return {};
  }
}

export function pdfReaderViewportFromLocation(
  location: PdfViewAreaLocation | null | undefined,
): PdfReaderViewport | null {
  if (!location) return null;
  // PDF.js exposes manual zoom in updateviewarea as a percentage, but its
  // currentScaleValue setter accepts a scale factor. Named modes pass through.
  const scaleValue =
    typeof location.scale === "number"
      ? Number.isFinite(location.scale) && location.scale > 0
        ? String(normalizePdfZoom(location.scale / 100))
        : null
      : location.scale;
  return normalizePdfReaderViewport({
    page: location.pageNumber,
    left: location.left,
    top: location.top,
    scaleValue,
    rotation: location.rotation,
  });
}

export function restorePdfReaderViewport(
  target: PdfViewportRestoreTarget,
  viewport: PdfReaderViewport | null,
  pageCount: number,
): number {
  if (viewport === null) {
    target.currentScaleValue = "page-width";
    return target.currentPageNumber;
  }
  const page = clampPdfPage(viewport.page, pageCount);
  target.pagesRotation = viewport.rotation;
  target.currentScaleValue = viewport.scaleValue;
  target.scrollPageIntoView({
    pageNumber: page,
    destArray: [null, { name: "XYZ" }, viewport.left, viewport.top, null],
    allowNegativeOffset: true,
    ignoreDestinationZoom: true,
  });
  return page;
}

function createBrowserStorage(): StateStorage {
  if (typeof window === "undefined") return createMemoryStorage();
  try {
    return window.localStorage;
  } catch {
    return createMemoryStorage();
  }
}

export function createPdfReaderSessionStore(
  options: PdfReaderSessionStoreOptions,
): PdfReaderSessionStore {
  const maxDocuments = Math.max(
    1,
    Math.trunc(options.maxDocuments ?? PDF_READER_SESSION_MAX_DOCUMENTS),
  );
  const writeDelayMs = Math.max(
    0,
    Math.trunc(options.writeDelayMs ?? PDF_READER_SESSION_WRITE_DELAY_MS),
  );
  const now = options.now ?? Date.now;
  let persistenceAvailable = true;
  let dirty = false;
  let writeHandle: ReturnType<typeof setTimeout> | null = null;
  let serialized: string | null = null;
  try {
    const stored = options.storage.getItem(PDF_READER_SESSION_STORAGE_KEY);
    serialized = typeof stored === "string" ? stored : null;
  } catch (error) {
    persistenceAvailable = false;
    options.onStorageError?.(error);
  }
  let sessions = decodePdfReaderSessions(serialized, maxDocuments);
  let latestTimestamp = Math.max(0, ...Object.values(sessions).map((session) => session.updatedAt));

  const nextTimestamp = () => {
    latestTimestamp = Math.max(Math.trunc(now()), latestTimestamp + 1);
    return latestTimestamp;
  };

  const persistNow = () => {
    if (!persistenceAvailable || !dirty) return;
    const persisted: PersistedPdfReaderSessions = {
      version: PDF_READER_SESSION_VERSION,
      sessions,
    };
    try {
      options.storage.setItem(PDF_READER_SESSION_STORAGE_KEY, JSON.stringify(persisted));
      dirty = false;
    } catch (error) {
      persistenceAvailable = false;
      options.onStorageError?.(error);
    }
  };

  const flush = () => {
    if (writeHandle !== null) {
      clearTimeout(writeHandle);
      writeHandle = null;
    }
    persistNow();
  };

  const schedulePersist = () => {
    if (!persistenceAvailable || writeHandle !== null) return;
    if (writeDelayMs === 0) {
      persistNow();
      return;
    }
    writeHandle = setTimeout(() => {
      writeHandle = null;
      persistNow();
    }, writeDelayMs);
  };

  const update = (
    documentKey: string,
    apply: (current: PdfReaderSession) => Omit<PdfReaderSession, "updatedAt">,
  ) => {
    if (!isDocumentKey(documentKey)) return;
    const current = sessions[documentKey] ?? EMPTY_SESSION;
    sessions = pruneSessions(
      {
        ...sessions,
        [documentKey]: { ...apply(current), updatedAt: nextTimestamp() },
      },
      maxDocuments,
    );
    dirty = true;
    schedulePersist();
  };

  return {
    get: (documentKey) => sessions[documentKey] ?? EMPTY_SESSION,
    copy: (sourceDocumentKey, destinationDocumentKey) => {
      if (!isDocumentKey(sourceDocumentKey) || !isDocumentKey(destinationDocumentKey)) return;
      const source = sessions[sourceDocumentKey];
      if (source === undefined || sourceDocumentKey === destinationDocumentKey) return;
      update(destinationDocumentKey, () => ({
        viewport: source.viewport,
        sidebar: source.sidebar,
      }));
    },
    updateViewport: (documentKey, viewport) => {
      const normalized = normalizePdfReaderViewport(viewport);
      if (normalized === null) return;
      update(documentKey, (current) => ({
        viewport: normalized,
        sidebar: current.sidebar,
      }));
    },
    updateSidebar: (documentKey, sidebar) => {
      const normalized = normalizeSidebar(sidebar);
      if (normalized === null) return;
      update(documentKey, (current) => ({
        viewport: current.viewport,
        sidebar: normalized,
      }));
    },
    flush,
    dispose: flush,
  };
}

export const pdfReaderSessionStore = createPdfReaderSessionStore({
  storage: createBrowserStorage(),
  onStorageError: (error) => {
    console.warn("[PDF_READER] Could not persist reader position; continuing in memory.", error);
  },
});

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  registerPdfReaderSessionTeardownFlush(
    (event, listener) => window.addEventListener(event, listener),
    pdfReaderSessionStore,
  );
}
