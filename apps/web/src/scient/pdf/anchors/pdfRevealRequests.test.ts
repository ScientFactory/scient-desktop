import {
  ArtifactAuthority,
  LogicalDocumentKey,
  PDF_TEXT_PROFILE,
  PdfTarget,
} from "@scientfactory/document-artifacts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  abandonPdfReveal,
  claimPdfReveal,
  ownsPdfReveal,
  pendingPdfReveal,
  releasePdfReveal,
  requestPdfReveal,
  resetPdfRevealRequests,
  takePdfReveal,
} from "./pdfRevealRequests";

const target = PdfTarget.make({
  version: 1,
  document: {
    authority: ArtifactAuthority.make("environment-1"),
    logicalDocumentKey: LogicalDocumentKey.make("workspace:/p/a.pdf"),
    title: "a.pdf",
    fileName: "a.pdf",
    locator: { _tag: "workspace", workspaceRoot: "/p", relativePath: "a.pdf" },
  },
  material: null,
  extractor: { profile: PDF_TEXT_PROFILE, version: "6.2.108" },
  selector: {
    type: "text",
    pages: [
      {
        page: 1,
        viewBox: [0, 0, 612, 792],
        rotation: 0,
        userUnit: 1,
        pageTextHash: "a".repeat(64),
        start: 0,
        end: 2,
        quote: "Hi",
        prefix: "",
        suffix: "",
      },
    ],
  },
});
const key = "document";

describe("pending quote reveals", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetPdfRevealRequests();
  });
  afterEach(() => vi.useRealTimers());

  it("abandons a request no reader has claimed, but never a claimed one", () => {
    const first = requestPdfReveal(key, target);
    abandonPdfReveal(key, first.id);
    expect(pendingPdfReveal(key)).toBeNull();
    const second = requestPdfReveal(key, target);
    claimPdfReveal(key, second.id, {});
    abandonPdfReveal(key, second.id);
    expect(pendingPdfReveal(key)).toBe(second);
  });

  it("keeps a claimed request while its reader loads, and only for that reader", () => {
    const request = requestPdfReveal(key, target);
    const reader = {};
    expect(claimPdfReveal(key, request.id, reader)).toBe(true);
    expect(claimPdfReveal(key, request.id, {})).toBe(false);
    vi.advanceTimersByTime(60_000);
    expect(pendingPdfReveal(key)).toBe(request);
    expect(ownsPdfReveal(key, request.id, reader)).toBe(true);
    expect(takePdfReveal(key, request.id)).toBe(true);
    expect(pendingPdfReveal(key)).toBeNull();
  });

  it("cancels a request when the reader that claimed it closes", () => {
    const request = requestPdfReveal(key, target);
    const reader = {};
    claimPdfReveal(key, request.id, reader);
    releasePdfReveal(key, {});
    vi.advanceTimersByTime(1);
    expect(pendingPdfReveal(key)).toBe(request);
    releasePdfReveal(key, reader);
    vi.advanceTimersByTime(1);
    expect(pendingPdfReveal(key)).toBeNull();
  });

  it("gives a newer request to whichever reader claims it next", () => {
    const first = requestPdfReveal(key, target);
    const reader = {};
    claimPdfReveal(key, first.id, reader);
    const second = requestPdfReveal(key, target);
    expect(ownsPdfReveal(key, second.id, reader)).toBe(false);
    expect(claimPdfReveal(key, second.id, {})).toBe(true);
  });

  it("keeps a claim through React's development replay (release, then claim again at once)", () => {
    const request = requestPdfReveal(key, target);
    const reader = {};
    claimPdfReveal(key, request.id, reader);
    releasePdfReveal(key, reader);
    claimPdfReveal(key, request.id, reader);
    vi.advanceTimersByTime(1);
    expect(ownsPdfReveal(key, request.id, reader)).toBe(true);
    // A real close: no claim follows.
    releasePdfReveal(key, reader);
    vi.advanceTimersByTime(1);
    expect(pendingPdfReveal(key)).toBeNull();
  });
});
