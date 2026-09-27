import {
  SCIENT_DOCUMENT_PAGE_PROTOCOL,
  type ScientDocumentPageBlockCounts,
  type ScientDocumentPageDiagnostic,
  type ScientDocumentPageFatalCode,
  type ScientDocumentPageInput,
  type ScientDocumentPageReadiness,
  type ScientDocumentPageWarningCode,
} from "@t3tools/contracts";

/** How long the page waits for diagrams and images before reporting them unfinished. */
export const DOCUMENT_PAGE_SETTLE_TIMEOUT_MS = 45_000;
/** The readiness contract carries at most this many diagnostics. */
const MAX_DIAGNOSTICS = 256;
/** Distinct fatal diagnostics kept; one is enough to refuse the page. */
const MAX_FATAL_DIAGNOSTICS = 32;
const MAX_DETAIL_LENGTH = 2_048;

const nextFrame = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );

/**
 * Collects the work the document page must finish before it may be printed,
 * and every diagnostic it finds along the way. Components register their
 * asynchronous work (diagrams, images) while rendering; `settle` waits for all
 * of it, including work that appears only after an earlier job commits.
 */
export class DocumentPageTracker {
  private readonly jobs = new Set<Promise<unknown>>();
  private readonly diagnosticKeys = new Set<string>();
  private readonly fatals: ScientDocumentPageDiagnostic[] = [];
  private readonly warnings: Array<
    Extract<ScientDocumentPageDiagnostic, { readonly severity: "warning" }>
  > = [];
  private omittedFatals = 0;
  readonly unresolvedAssets = new Set<string>();

  /**
   * Every fatal diagnostic first, so no number of warnings can hide one, then
   * warnings up to the contract's limit; warnings that do not fit are counted
   * in one closing note.
   */
  get diagnostics(): ReadonlyArray<ScientDocumentPageDiagnostic> {
    const fatals = this.fatals;
    const room = MAX_DIAGNOSTICS - fatals.length;
    if (this.warnings.length <= room) return [...fatals, ...this.warnings];
    const shown = this.warnings.slice(0, room - 1);
    const omitted = this.warnings.length - shown.length;
    return [
      ...fatals,
      ...shown,
      {
        severity: "warning",
        code: this.warnings[0]!.code,
        detail: `${omitted} more limitations were found and are not listed.`,
      },
    ];
  }

  /** Whether any fatal diagnostic was recorded, including ones beyond the kept list. */
  get failed(): boolean {
    return this.fatals.length > 0 || this.omittedFatals > 0;
  }

  /** Registers work that must finish before readiness; returns its completion callback. */
  track(): () => void {
    let finish!: () => void;
    const job = new Promise<void>((resolve) => {
      finish = resolve;
    });
    this.jobs.add(job);
    void job.then(() => this.jobs.delete(job));
    return finish;
  }

  warn(code: ScientDocumentPageWarningCode, detail: string): void {
    this.record({ severity: "warning", code, detail: detail.slice(0, MAX_DETAIL_LENGTH) });
  }

  fatal(code: ScientDocumentPageFatalCode, detail: string): void {
    this.record({ severity: "fatal", code, detail: detail.slice(0, MAX_DETAIL_LENGTH) });
  }

  private record(diagnostic: ScientDocumentPageDiagnostic): void {
    const key = `${diagnostic.severity}:${diagnostic.code}:${diagnostic.detail}`;
    if (this.diagnosticKeys.has(key)) return;
    this.diagnosticKeys.add(key);
    if (diagnostic.severity === "warning") {
      this.warnings.push(diagnostic);
    } else if (this.fatals.length < MAX_FATAL_DIAGNOSTICS) {
      this.fatals.push(diagnostic);
    } else {
      this.omittedFatals += 1;
    }
  }

  /** Resolves true once no tracked work remains, or false at the deadline. */
  async settle(timeoutMs = DOCUMENT_PAGE_SETTLE_TIMEOUT_MS): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    await nextFrame();
    while (this.jobs.size > 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = await Promise.race([
        Promise.allSettled(this.jobs).then(() => false),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(true), remaining);
        }),
      ]);
      clearTimeout(timer);
      if (timedOut) return false;
      // Let React commit what the finished jobs produced before looking again.
      await nextFrame();
    }
    return true;
  }
}

/** Counts rendered structure so the printer can see the page is the complete document. */
export function countDocumentBlocks(article: ParentNode): ScientDocumentPageBlockCounts {
  const count = (selector: string) => article.querySelectorAll(selector).length;
  return {
    headings: count("h1, h2, h3, h4, h5, h6"),
    paragraphs: count("p"),
    lists: count("ul, ol"),
    tables: count("table"),
    codeBlocks: count("[data-scient-code-block]"),
    inlineMath: count("[data-scient-math='inline']"),
    displayMath: count("[data-scient-math='display']"),
    diagrams: count("[data-scient-diagram]"),
    images: count("img"),
  };
}

/**
 * Makes in-document links point at the ids the sanitizer actually emitted,
 * so they become working PDF link annotations.
 */
export function resolveInternalLinks(article: ParentNode): void {
  for (const anchor of article.querySelectorAll<HTMLAnchorElement>('a[href^="#"]')) {
    const fragment = decodeURIComponent(anchor.getAttribute("href")!.slice(1));
    if (!fragment) continue;
    const target = [fragment, `user-content-${fragment}`, `user-content-user-content-${fragment}`]
      .map((id) => (article as Document | Element).querySelector(`[id="${CSS.escape(id)}"]`))
      .find((element) => element !== null);
    if (target) anchor.setAttribute("href", `#${target.id}`);
  }
}

/**
 * Waits for the fonts the page used and checks each one. `fonts.ready`
 * resolves even when a face failed to load (the page then silently prints a
 * fallback), so every face the page requested must itself report `loaded`.
 * Faces the page never used stay `unloaded` and do not matter.
 */
export async function settleDocumentFonts(
  fonts: FontFaceSet,
  tracker: DocumentPageTracker,
): Promise<boolean> {
  try {
    await fonts.ready;
  } catch {
    tracker.fatal("fonts-unsettled", "The document's fonts did not finish loading.");
    return false;
  }
  let settled = true;
  for (const face of fonts) {
    if (face.status === "error") {
      settled = false;
      tracker.fatal("fonts-unsettled", `The font "${face.family}" failed to load.`);
    } else if (face.status === "loading") {
      settled = false;
      tracker.fatal("fonts-unsettled", `The font "${face.family}" did not finish loading.`);
    }
  }
  return settled;
}

/** Inspects the committed page and builds the report the desktop checks before printing. */
export async function collectDocumentPageReadiness(input: {
  readonly page: ScientDocumentPageInput;
  readonly article: HTMLElement;
  readonly tracker: DocumentPageTracker;
  readonly settled: boolean;
}): Promise<ScientDocumentPageReadiness> {
  const { article, tracker, page } = input;
  const fontsSettled = await settleDocumentFonts(document.fonts, tracker);
  if (!input.settled) {
    tracker.fatal(
      "render-crashed",
      "The document page did not finish rendering diagrams and images in time.",
    );
  }
  const pendingDiagrams = article.querySelectorAll("[data-scient-diagram='pending']").length;
  if (pendingDiagrams > 0) {
    tracker.fatal(
      "diagram-incomplete",
      `${pendingDiagrams} diagram${pendingDiagrams === 1 ? "" : "s"} did not finish rendering.`,
    );
  }
  let imagesSettled = true;
  for (const image of article.querySelectorAll<HTMLImageElement>("img")) {
    if (!image.complete) {
      imagesSettled = false;
      tracker.fatal(
        "image-incomplete",
        `Image "${image.alt || image.src}" did not finish loading.`,
      );
      continue;
    }
    if (image.naturalWidth === 0) {
      const assetId = image.dataset.scientAsset;
      if (assetId) {
        tracker.unresolvedAssets.add(assetId);
        tracker.fatal("resource-unresolved", `A captured image (${assetId}) could not be loaded.`);
      } else {
        tracker.warn("missing-image", `Image "${image.alt || "untitled"}" could not be displayed.`);
      }
    }
  }
  resolveInternalLinks(article);
  const status = tracker.failed ? "failed" : "ready";
  return {
    protocol: SCIENT_DOCUMENT_PAGE_PROTOCOL,
    status,
    captureId: page.captureId,
    documentKind: page.documentKind,
    sourceDigest: page.sourceDigest,
    title: page.title,
    blocks: countDocumentBlocks(article),
    unresolvedAssets: [...tracker.unresolvedAssets],
    settled: {
      fonts: fontsSettled,
      math: article.querySelectorAll("[data-scient-math='pending']").length === 0,
      diagrams: input.settled && pendingDiagrams === 0,
      images: imagesSettled,
    },
    diagnostics: tracker.diagnostics,
  };
}

/** The limitations a readiness report found, as they are printed in the export notes. */
export function readinessWarningNotes(
  readiness: ScientDocumentPageReadiness,
): ReadonlyArray<string> {
  return readiness.diagnostics.flatMap((diagnostic) =>
    diagnostic.severity === "warning" ? [diagnostic.detail] : [],
  );
}

/**
 * Renders until the printed export notes list every limitation the page
 * found, including ones only its final inspection sees, so the PDF never
 * omits a warning the export reports. Each pass renders, settles, and
 * inspects; it stops once the notes match or after `maxPasses`.
 */
export async function renderWithCompleteNotes(input: {
  readonly render: (notes: ReadonlyArray<string>) => void;
  readonly tracker: DocumentPageTracker;
  readonly inspect: (settled: boolean) => Promise<ScientDocumentPageReadiness>;
  readonly maxPasses?: number;
}): Promise<ScientDocumentPageReadiness> {
  let printed: ReadonlyArray<string> = [];
  let settled = true;
  const maxPasses = input.maxPasses ?? 3;
  for (let pass = 1; ; pass += 1) {
    input.render(printed);
    settled = (await input.tracker.settle()) && settled;
    const readiness = await input.inspect(settled);
    const notes = readinessWarningNotes(readiness);
    const complete =
      notes.length === printed.length && notes.every((note, index) => note === printed[index]);
    if (complete) return readiness;
    if (pass >= maxPasses) {
      input.tracker.fatal(
        "render-crashed",
        "The document page kept finding new limitations and could not list them all.",
      );
      return { ...readiness, status: "failed", diagnostics: input.tracker.diagnostics };
    }
    printed = notes;
  }
}

/** The report for a page that could not render its input at all. */
export function failedDocumentPageReadiness(
  tracker: DocumentPageTracker,
  page: ScientDocumentPageInput | null,
): ScientDocumentPageReadiness {
  if (!tracker.failed) {
    tracker.fatal("render-crashed", "The document page stopped before it finished rendering.");
  }
  return {
    protocol: SCIENT_DOCUMENT_PAGE_PROTOCOL,
    status: "failed",
    captureId: page?.captureId ?? null,
    documentKind: page?.documentKind ?? null,
    sourceDigest: page?.sourceDigest ?? null,
    title: page?.title ?? "",
    blocks: {
      headings: 0,
      paragraphs: 0,
      lists: 0,
      tables: 0,
      codeBlocks: 0,
      inlineMath: 0,
      displayMath: 0,
      diagrams: 0,
      images: 0,
    },
    unresolvedAssets: [...tracker.unresolvedAssets],
    settled: { fonts: false, math: false, diagrams: false, images: false },
    diagnostics: tracker.diagnostics,
  };
}
