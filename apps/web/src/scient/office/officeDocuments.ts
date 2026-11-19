import type { OfficeWorkerResult } from "~/components/files/officePreviewProtocol";

import {
  documentCache,
  type DocumentKind,
  type DocumentLease,
} from "../documentCache/documentCache";
import type { OfficeSessionSlot } from "./officeSession";

type Prepared = Extract<OfficeWorkerResult, { bytes: ArrayBuffer }>;

/** A Word or PowerPoint file prepared for its engine, and the engine's session once a viewer opens it. */
export interface OfficeDocument {
  readonly prepared: Prepared;
  readonly session: OfficeSessionSlot;
}

const officeKind: DocumentKind<OfficeDocument> = {
  dispose: (document) => {
    document.session.current?.close();
    document.session.current = null;
  },
  healthy: (document) => !document.session.current?.failed(),
  // The engine's own estimate once a viewer opened it; before, only the prepared file.
  size: (document) =>
    document.session.current?.memory() ?? document.prepared.bytes.byteLength * 2 + 1024 * 1024,
};

/**
 * Leases the Office document at `key` (null when its revision is unknown), preparing it with
 * `prepare` unless a reader left it recently, laid out, in its session.
 */
export function acquireOfficeDocument(
  key: string | null,
  prepare: (signal: AbortSignal) => Promise<Prepared>,
): DocumentLease<OfficeDocument> {
  return documentCache.acquire(
    key,
    async (signal) => ({ prepared: await prepare(signal), session: { current: null } }),
    officeKind,
  );
}
