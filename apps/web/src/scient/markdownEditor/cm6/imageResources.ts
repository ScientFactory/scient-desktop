export type MarkdownImageSourceResolver = (authoredSource: string) => Promise<string | null>;

type ImageResourceEntry =
  | { readonly status: "pending"; readonly request: object }
  | { readonly status: "settled"; readonly url: string | null };

/**
 * Async image resources for one CM6 document controller. Entries never cross
 * workspaces or controller lifetimes, concurrent requests are coalesced, and
 * late resolutions cannot update a destroyed editor.
 */
export class MarkdownImageResourceScope {
  private readonly entries = new Map<string, ImageResourceEntry>();
  private disposed = false;

  constructor(
    private readonly resolver: MarkdownImageSourceResolver,
    private readonly onResourceChange: () => void,
  ) {}

  lookup(authoredSource: string): string | null {
    const entry = this.entries.get(authoredSource);
    return entry?.status === "settled" ? entry.url : null;
  }

  request(authoredSource: string): void {
    if (this.disposed || this.entries.has(authoredSource)) return;
    const request = {};
    this.entries.set(authoredSource, { status: "pending", request });

    void Promise.resolve()
      .then(() => this.resolver(authoredSource))
      .then(
        (url) => this.settle(authoredSource, request, url),
        () => this.settle(authoredSource, request, null),
      );
  }

  dispose(): void {
    this.disposed = true;
    this.entries.clear();
  }

  private settle(authoredSource: string, request: object, url: string | null): void {
    if (this.disposed) return;
    const current = this.entries.get(authoredSource);
    if (current?.status !== "pending" || current.request !== request) return;
    this.entries.set(authoredSource, { status: "settled", url });
    this.onResourceChange();
  }
}
