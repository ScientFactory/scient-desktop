import { createContext } from "react";

/**
 * Names the content a document preview shows, its file and revision, so the opened document can
 * be kept for a reader who comes back (documentCache.ts). Null when the revision is unknown: such
 * a document is opened afresh each time.
 */
export const DocumentIdentityContext = createContext<string | null>(null);
