import { stackedThreadToast, toastManager } from "~/components/ui/toast";

/**
 * Says when a link led to a different page than it names, so an unexpected
 * match is noticed. Only for a page opened in the browser: a file opened in
 * the panel carries the same note on its own tab, where it covers nothing.
 */
export function announceResolvedLink(link: {
  /** The file that was opened. */
  readonly path: string;
  /** Where the link pointed. */
  readonly missingPath: string;
}): void {
  toastManager.add(
    stackedThreadToast({
      type: "info",
      title: `Link resolved to ${link.path}`,
      description: `Nothing existed at ${link.missingPath}, where the link pointed.`,
    }),
  );
}
