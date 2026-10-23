import type { PdfTarget } from "@scientfactory/document-artifacts";
import { useEffect, useState, useSyncExternalStore } from "react";

import { pdfReaderSessionDocumentKey } from "../pdfReaderSessionStore";

/**
 * Pending "show this quote" requests, keyed by document (authority and
 * logical key, without the reader scope). A chip click files one and opens
 * the document. While it waits, it lives as long as its PDF stays the panel's
 * active view (the opener watches that). The reader that shows the document
 * claims it and keeps it for as long as it takes to load (a slow download, a
 * password); closing that reader cancels it.
 */
export interface PdfRevealRequest {
  readonly id: number;
  readonly target: PdfTarget;
}

const requests = new Map<string, PdfRevealRequest>();
const owners = new Map<string, object>();
/** A release waits a task, so React's development replay (unmount, mount) keeps the claim. */
const releases = new Map<string, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();
let nextId = 1;

function notify() {
  for (const listener of listeners) listener();
}

function remove(documentKey: string) {
  clearTimeout(releases.get(documentKey));
  releases.delete(documentKey);
  requests.delete(documentKey);
  owners.delete(documentKey);
  notify();
}

export function pdfRevealDocumentKey(document: {
  readonly authority: string;
  readonly logicalDocumentKey: string;
}): string {
  return pdfReaderSessionDocumentKey(document);
}

export function requestPdfReveal(documentKey: string, target: PdfTarget): PdfRevealRequest {
  const request = { id: nextId++, target };
  requests.set(documentKey, request);
  owners.delete(documentKey);
  notify();
  return request;
}

export function pendingPdfReveal(documentKey: string): PdfRevealRequest | null {
  return requests.get(documentKey) ?? null;
}

export function pdfRevealClaimed(documentKey: string, id: number): boolean {
  return requests.get(documentKey)?.id === id && owners.has(documentKey);
}

/** The user left the PDF before any reader claimed the request. */
export function abandonPdfReveal(documentKey: string, id: number): void {
  if (requests.get(documentKey)?.id === id && !owners.has(documentKey)) remove(documentKey);
}

/** A reader showing the document takes charge of the request; true if it is now its owner. */
export function claimPdfReveal(documentKey: string, id: number, owner: object): boolean {
  if (pendingPdfReveal(documentKey)?.id !== id) return false;
  const current = owners.get(documentKey);
  if (current !== undefined && current !== owner) return false;
  clearTimeout(releases.get(documentKey));
  releases.delete(documentKey);
  if (current === undefined) {
    owners.set(documentKey, owner);
    notify();
  }
  return true;
}

export function ownsPdfReveal(documentKey: string, id: number, owner: object): boolean {
  return requests.get(documentKey)?.id === id && owners.get(documentKey) === owner;
}

/** Completes the request: shown, or reported as not showable. */
export function takePdfReveal(documentKey: string, id: number): boolean {
  if (requests.get(documentKey)?.id !== id) return false;
  remove(documentKey);
  return true;
}

/** Its reader closed: the request it owned is abandoned, unless the same reader claims it again at once. */
export function releasePdfReveal(documentKey: string, owner: object): void {
  if (owners.get(documentKey) !== owner) return;
  clearTimeout(releases.get(documentKey));
  releases.set(
    documentKey,
    setTimeout(() => {
      releases.delete(documentKey);
      if (owners.get(documentKey) === owner) remove(documentKey);
    }, 0),
  );
}

/** Abandons every pending request: a newer navigation replaced them. */
export function clearPdfReveals(): void {
  for (const timer of releases.values()) clearTimeout(timer);
  releases.clear();
  if (requests.size === 0) return;
  requests.clear();
  owners.clear();
  notify();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePdfRevealRequest(documentKey: string): PdfRevealRequest | null {
  return useSyncExternalStore(subscribe, () => pendingPdfReveal(documentKey));
}

/** The pending request for the document, if this reader owns it. */
export function useOwnedPdfReveal(documentKey: string, owner: object): PdfRevealRequest | null {
  return useSyncExternalStore(subscribe, () => {
    const request = pendingPdfReveal(documentKey);
    return request && owners.get(documentKey) === owner ? request : null;
  });
}

/**
 * Claims, for as long as the calling reader is mounted, the pending reveal of
 * the document it shows. Mounted by the reader's outer shell, so the claim
 * covers authorization and loading as well as the painted reader.
 */
export function usePdfRevealClaim(documentKey: string): object {
  const [owner] = useState(() => ({}));
  const request = usePdfRevealRequest(documentKey);
  useEffect(() => {
    if (request) claimPdfReveal(documentKey, request.id, owner);
  }, [documentKey, owner, request]);
  useEffect(() => () => releasePdfReveal(documentKey, owner), [documentKey, owner]);
  return owner;
}

/** Test seam: forget every pending request. */
export function resetPdfRevealRequests(): void {
  clearPdfReveals();
}
