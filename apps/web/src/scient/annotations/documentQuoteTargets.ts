import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import { useEffect, useRef } from "react";

import { toastManager } from "~/components/ui/toast";

import { markdownQuote, type DocumentQuote } from "./quoteFormat";

/** An open Markdown or LaTeX editor that can take a quote at its cursor. */
export interface DocumentQuoteTarget {
  readonly root: string;
  /** The document's name, for the confirmation. */
  readonly label: string;
  readonly element: () => HTMLElement | null;
  /** False when the editor cannot take it now, such as while read-only. */
  readonly insert: (quote: DocumentQuote) => boolean;
}

interface Registered {
  readonly target: { readonly current: DocumentQuoteTarget | null };
  focusedAt: number;
}

const registered = new Set<Registered>();
let focusOrder = 0;

function noteFocus(event: FocusEvent): void {
  const node = event.target instanceof Node ? event.target : null;
  for (const entry of registered) {
    if (node && entry.target.current?.element()?.contains(node)) entry.focusedAt = ++focusOrder;
  }
}

/** Offers this editor to "Quote in my document" while it is mounted; the last one focused wins. */
export function useDocumentQuoteTarget(target: DocumentQuoteTarget | null): void {
  const latest = useRef(target);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the registered target current for a quote inserted later
  useEffect(() => {
    latest.current = target;
  });
  const enabled = target !== null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers this editor with the window's quote targets, which track focus across editors
  useEffect(() => {
    if (!enabled) return;
    const entry: Registered = { target: latest, focusedAt: ++focusOrder };
    if (registered.size === 0) window.addEventListener("focusin", noteFocus, true);
    registered.add(entry);
    return () => {
      registered.delete(entry);
      if (registered.size === 0) window.removeEventListener("focusin", noteFocus, true);
    };
  }, [enabled]);
}

function latestTarget(root: string): DocumentQuoteTarget | null {
  const project = normalizeProjectPathForComparison(root);
  let best: Registered | null = null;
  for (const entry of registered) {
    const candidate = entry.target.current;
    if (!candidate || normalizeProjectPathForComparison(candidate.root) !== project) continue;
    if (!best || entry.focusedAt > best.focusedAt) best = entry;
  }
  return best?.target.current ?? null;
}

/**
 * Puts a highlighted passage, with its citation, into the document the writer
 * used last in this project. Without an open document, it is copied instead.
 */
export async function quoteInDocument(root: string, quote: DocumentQuote): Promise<void> {
  const target = latestTarget(root);
  if (target?.insert(quote)) {
    toastManager.add({ type: "success", title: `Quoted in ${target.label}` });
    return;
  }
  try {
    await navigator.clipboard.writeText(markdownQuote(quote).markdown);
    toastManager.add({
      type: "info",
      title: "Quote copied",
      description: "Open a Markdown or LaTeX document to insert quotes there.",
    });
  } catch {
    toastManager.add({ type: "error", title: "Couldn't copy the quote" });
  }
}
