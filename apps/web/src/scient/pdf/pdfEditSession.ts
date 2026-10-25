import { sha256 } from "@noble/hashes/sha2";
import { randomUUID } from "~/lib/utils";
import type { ScientPdfEditSaveResult } from "@t3tools/contracts";
import {
  PDF_EDIT_MAX_BYTES,
  PDF_EDIT_TAGGED_MESSAGE,
  createPdfEditId,
  keepsEveryPageOnce,
  insertPdfPages,
  movePdfPages,
  pdfInsertionIndex,
  selectedPdfPages,
  type PdfEditFrame,
  type PdfEditPage,
  type PdfEditWorkerRequest,
  type PdfEditWorkerResponse,
} from "./pdfPageEdits";

type WorkerInput =
  | Omit<Extract<PdfEditWorkerRequest, { kind: "load" }>, "id">
  | Omit<Extract<PdfEditWorkerRequest, { kind: "build" }>, "id">
  | Omit<Extract<PdfEditWorkerRequest, { kind: "release" }>, "id">;
type HistoryEntry = { frame: PdfEditFrame; focus: string | null };
type Persist = (
  bytes: Uint8Array,
  expectedRevision: string,
  operationId: string,
) => Promise<ScientPdfEditSaveResult>;
const EMPTY_FRAME: PdfEditFrame = { pages: [], selection: [] };
const revisionForBytes = (bytes: Uint8Array) =>
  "sha256:" + [...sha256(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

export class PdfEditSession {
  private listeners = new Set<() => void>();
  private unusedTimer: ReturnType<typeof setTimeout> | null = null;
  private worker: Worker | null = null;
  private sequence = 0;
  private pending = new Map<
    number,
    { resolve: (response: PdfEditWorkerResponse) => void; reject: (error: Error) => void }
  >();
  private past: HistoryEntry[] = [];
  private future: HistoryEntry[] = [];
  private baseBytes: Uint8Array | null = null;
  private basePages: readonly PdfEditPage[] = [];
  private revision = "";
  private persist: Persist | null = null;
  private queue: Promise<void> = Promise.resolve();
  private focusedId: string | null = null;
  private anchor: string | null = null;
  private snapshot = {
    active: false,
    busy: false,
    /** The PDF has a structure tree, so its original pages cannot be deleted or duplicated. */
    tagged: false,
    error: null as string | null,
    frame: EMPTY_FRAME,
    url: null as string | null,
    bytes: null as Uint8Array | null,
    canUndo: false,
    canRedo: false,
    savedPath: null as string | null,
    savedSource: null as ScientPdfEditSaveResult["source"] | null,
    copiedPath: null as string | null,
    restorePage: 1,
  };

  constructor(private readonly onUnused?: () => void) {}

  subscribe = (listener: () => void) => {
    if (this.unusedTimer !== null) clearTimeout(this.unusedTimer);
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size) return;
      // Allow a React resubscription, and finish any admitted save before releasing its worker.
      this.unusedTimer = setTimeout(() => {
        void this.queue.then(() => {
          if (this.listeners.size) return;
          this.clearState();
          this.onUnused?.();
        });
      }, 0);
    };
  };
  getSnapshot = () => this.snapshot;
  configure(persist: Persist) {
    if (!this.snapshot.active) this.persist = persist;
  }
  private update(patch: Partial<typeof this.snapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }
  private request(input: WorkerInput) {
    if (!this.worker) {
      this.worker = new Worker(new URL("./pdfEdit.worker.ts", import.meta.url), { type: "module" });
      this.worker.addEventListener("message", (event: MessageEvent<PdfEditWorkerResponse>) => {
        const result = event.data,
          pending = this.pending.get(result.id);
        this.pending.delete(result.id);
        if (result.kind === "error") pending?.reject(new Error(result.message));
        else pending?.resolve(result);
      });
      this.worker.addEventListener("error", () => {
        for (const pending of this.pending.values())
          pending.reject(new Error("The PDF worker stopped. Reopen the PDF to continue."));
        this.pending.clear();
      });
    }
    const id = ++this.sequence;
    return new Promise<PdfEditWorkerResponse>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Worker messages do not use Window origins.
      this.worker!.postMessage({ ...input, id });
    });
  }
  run(operation: () => Promise<void>) {
    const task = this.queue.then(async () => {
      this.update({ busy: true, error: null });
      try {
        await operation();
      } catch (error) {
        this.update({
          error: error instanceof Error ? error.message : "The PDF operation failed.",
        });
      } finally {
        this.update({ busy: false });
      }
    });
    this.queue = task;
    return task;
  }
  prepareSelection(pageCount: number) {
    if (this.snapshot.active || pageCount < 1 || this.snapshot.frame.pages.length === pageCount)
      return;
    const pages = Array.from({ length: pageCount }, (_, index): PdfEditPage => ({
      id: `page-${index + 1}`,
      sourceId: null,
      sourceIndex: index,
      width: 0,
      height: 0,
      rotation: 0,
    }));
    const valid = new Set(pages.map((page) => page.id));
    this.update({
      frame: { pages, selection: this.snapshot.frame.selection.filter((id) => valid.has(id)) },
    });
  }
  start = (getBytes: () => Promise<Uint8Array>, pageNumber: number) =>
    this.run(async () => {
      if (this.snapshot.active) return;
      const bytes = await getBytes();
      const result = await this.request({ kind: "load", sourceId: createPdfEditId(), bytes });
      if (result.kind !== "loaded") throw new Error("Could not open this PDF for editing.");
      this.baseBytes = bytes;
      const previous = this.snapshot.frame;
      const pages = result.pages.map((page, index) => ({
        ...page,
        id: previous.pages[index]?.id ?? page.id,
      }));
      this.basePages = pages;
      this.revision = revisionForBytes(bytes);
      this.focusedId = pages[pageNumber - 1]?.id ?? pages[0]!.id;
      this.update({
        active: true,
        tagged: result.tagged,
        frame: { pages, selection: previous.selection },
        bytes,
      });
    });
  focus(pageNumber: number) {
    this.focusedId = this.snapshot.frame.pages[pageNumber - 1]?.id ?? this.focusedId;
  }
  private async build(frame: PdfEditFrame) {
    if (frame.pages === this.basePages && this.baseBytes) return this.baseBytes;
    const result = await this.request({ kind: "build", pages: frame.pages });
    if (result.kind !== "built") throw new Error("Could not assemble the PDF.");
    return result.bytes;
  }
  private async save(bytes: Uint8Array) {
    if (!this.persist) throw new Error("This PDF cannot be saved in its environment.");
    const result = await this.persist(bytes, this.revision, randomUUID());
    this.revision = result.revision;
    this.update({
      savedPath: result.path,
      savedSource: result.source,
      ...(result.createdCopy ? { copiedPath: result.path } : {}),
    });
  }
  private publish(frame: PdfEditFrame, bytes: Uint8Array, focus = this.focusedId) {
    const oldIndex = this.snapshot.frame.pages.findIndex((page) => page.id === focus);
    const target = frame.pages.some((page) => page.id === focus)
      ? focus
      : frame.pages[Math.max(0, Math.min(oldIndex, frame.pages.length - 1))]!.id;
    this.focusedId = target;
    const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: "application/pdf" }));
    const previousUrl = this.snapshot.url;
    this.update({
      frame,
      bytes,
      url,
      restorePage: frame.pages.findIndex((page) => page.id === target) + 1,
      canUndo: this.past.length > 0,
      canRedo: this.future.length > 0,
    });
    if (previousUrl) URL.revokeObjectURL(previousUrl);
  }
  change = (transform: (frame: PdfEditFrame) => PdfEditFrame) =>
    this.run(async () => {
      if (!this.snapshot.active) throw new Error("Open the PDF for editing before changing pages.");
      const previous = this.snapshot.frame,
        focus = this.focusedId;
      const next = transform(previous);
      if (next === previous) return;
      const baseSourceId = this.basePages[0]?.sourceId;
      if (
        this.snapshot.tagged &&
        baseSourceId &&
        !keepsEveryPageOnce(next.pages, baseSourceId, this.basePages.length)
      )
        throw new Error(PDF_EDIT_TAGGED_MESSAGE);
      const bytes = await this.build(next);
      // History and the displayed document advance only after durable publication.
      await this.save(bytes);
      this.past = [...this.past.slice(-99), { frame: previous, focus }];
      this.future = [];
      this.publish(next, bytes);
    });
  undo = () => this.travel("undo");
  redo = () => this.travel("redo");
  private travel(direction: "undo" | "redo") {
    return this.run(async () => {
      const from = direction === "undo" ? this.past : this.future;
      const to = direction === "undo" ? this.future : this.past;
      const next = from.at(-1);
      if (!next) return;
      const bytes = await this.build(next.frame);
      await this.save(bytes);
      from.pop();
      to.push({ frame: this.snapshot.frame, focus: this.focusedId });
      this.publish(next.frame, bytes, next.focus);
    });
  }
  toggle(pageNumber: number, shiftKey = false) {
    if (this.snapshot.busy) return;
    const frame = this.snapshot.frame,
      page = frame.pages[pageNumber - 1];
    if (!page) return;
    const checked = frame.selection.includes(page.id);
    let selection = new Set(frame.selection);
    if (shiftKey && this.anchor) {
      const start = Math.max(
        0,
        frame.pages.findIndex((entry) => entry.id === this.anchor),
      );
      for (const entry of frame.pages.slice(
        Math.min(start, pageNumber - 1),
        Math.max(start, pageNumber - 1) + 1,
      ))
        if (checked) selection.delete(entry.id);
        else selection.add(entry.id);
    } else if (checked) selection.delete(page.id);
    else selection.add(page.id);
    if (!shiftKey || !this.anchor) this.anchor = page.id;
    this.update({ frame: { ...frame, selection: [...selection] } });
  }
  selectPages(numbers: readonly number[]) {
    if (this.snapshot.busy) return;
    const frame = this.snapshot.frame;
    const selection = numbers.flatMap((number) =>
      frame.pages[number - 1] ? [frame.pages[number - 1]!.id] : [],
    );
    this.anchor = selection[0] ?? null;
    this.update({ frame: { ...frame, selection } });
  }
  rotate = (angle: number, target?: readonly string[]) =>
    this.change((frame) => {
      const selection = target ?? frame.selection;
      return selection.length
        ? {
            ...frame,
            pages: frame.pages.map((page) =>
              selection.includes(page.id)
                ? { ...page, rotation: (((page.rotation + angle) % 360) + 360) % 360 }
                : page,
            ),
          }
        : frame;
    });
  move = (boundary: number, target?: readonly string[]) =>
    this.change((frame) => movePdfPages(frame, boundary, target));
  duplicate = (target?: readonly string[]) =>
    this.change((frame) => {
      const actionFrame = target ? { ...frame, selection: target } : frame;
      if (!actionFrame.selection.length) return frame;
      const next = insertPdfPages(
        frame,
        selectedPdfPages(actionFrame).map((page) => ({ ...page, id: createPdfEditId() })),
        pdfInsertionIndex(actionFrame, "after"),
      );
      return target ? { ...next, selection: frame.selection } : next;
    });
  delete = (target?: readonly string[]) =>
    this.change((frame) => {
      const selection = target ?? frame.selection;
      if (!selection.length) return frame;
      const pages = frame.pages.filter((page) => !selection.includes(page.id));
      if (!pages.length) throw new Error("Keep at least one page in the PDF.");
      if (target) return { pages, selection: frame.selection.filter((id) => !target.includes(id)) };
      const first = frame.pages.findIndex((page) => selection.includes(page.id));
      return { pages, selection: [pages[Math.min(first, pages.length - 1)]!.id] };
    });
  blank = (boundary: number) =>
    this.change((frame) => {
      const adjacent = frame.pages[Math.max(0, boundary - 1)] ?? frame.pages[0]!;
      return insertPdfPages(
        frame,
        [{ ...adjacent, id: createPdfEditId(), sourceId: null, sourceIndex: 0 }],
        boundary,
      );
    });
  async loadFile(file: File) {
    if (file.size > PDF_EDIT_MAX_BYTES) throw new Error("Choose a PDF smaller than 50 MB.");
    const result = await this.request({
      kind: "load",
      sourceId: createPdfEditId(),
      bytes: new Uint8Array(await file.arrayBuffer()),
    });
    if (result.kind !== "loaded") throw new Error(`Could not read ${file.name}.`);
    return result.pages;
  }
  /** Frees an imported PDF that was never inserted, returning its share of the size limit. */
  releaseFile(sourceId: string) {
    if (this.worker) void this.request({ kind: "release", sourceId }).catch(() => undefined);
  }
  insert = (pages: readonly PdfEditPage[], index: number) =>
    this.change((frame) =>
      insertPdfPages(
        frame,
        pages.map((page) => ({ ...page, id: createPdfEditId() })),
        index,
      ),
    );
  private clearState() {
    this.worker?.terminate();
    this.worker = null;
    for (const pending of this.pending.values()) pending.reject(new Error("PDF reloaded."));
    this.pending.clear();
    if (this.snapshot.url) URL.revokeObjectURL(this.snapshot.url);
    this.past = [];
    this.future = [];
    this.baseBytes = null;
    this.basePages = [];
    this.persist = null;
    this.revision = "";
    this.focusedId = null;
    this.anchor = null;
    this.update({
      active: false,
      tagged: false,
      frame: EMPTY_FRAME,
      url: null,
      bytes: null,
      canUndo: false,
      canRedo: false,
      savedPath: null,
      savedSource: null,
      copiedPath: null,
      restorePage: 1,
    });
  }
  reset = () => this.run(async () => this.clearState());
  dismissError = () => this.update({ error: null });
}

const sessions = new Map<string, PdfEditSession>();
if (typeof window !== "undefined")
  window.addEventListener("beforeunload", (event) => {
    if (![...sessions.values()].some((session) => session.getSnapshot().busy)) return;
    event.preventDefault();
    event.returnValue = "";
  });
export function pdfEditSession(documentKey: string) {
  let session = sessions.get(documentKey);
  if (!session) {
    const candidate = new PdfEditSession(() => {
      if (sessions.get(documentKey) === candidate) sessions.delete(documentKey);
    });
    session = candidate;
    sessions.set(documentKey, session);
  }
  return session;
}
