const SOURCE_CHANGED_MESSAGE = "The HTML source changed again while it was reloading.";
const TARGET_CHANGED_MESSAGE = "The HTML Browser target changed while it was reloading.";

interface HtmlPdfUpdateTransaction {
  readonly renewAuthorizedUrl: () => Promise<string>;
  readonly navigate: (authorizedUrl: string) => Promise<void>;
  readonly commitAuthorizedUrl: (authorizedUrl: string) => void;
  readonly waitForReadiness: () => Promise<void>;
  readonly isNavigationTargetCurrent: () => boolean;
  readonly isCurrent: () => boolean;
  readonly hasArtifact: () => boolean;
  readonly exportPdf: (authorizedUrl: string) => Promise<void>;
}

function assertCurrent(isCurrent: () => boolean): void {
  if (!isCurrent()) throw new Error(SOURCE_CHANGED_MESSAGE);
}

/**
 * Regenerates one linked HTML PDF revision. The authorized URL becomes the
 * relation's current page only after the desktop Browser accepts navigation.
 */
export async function runHtmlPdfUpdateTransaction(
  transaction: HtmlPdfUpdateTransaction,
): Promise<void> {
  const authorizedUrl = await transaction.renewAuthorizedUrl();
  assertCurrent(transaction.isCurrent);
  await transaction.navigate(authorizedUrl);
  if (!transaction.isNavigationTargetCurrent()) throw new Error(TARGET_CHANGED_MESSAGE);
  transaction.commitAuthorizedUrl(authorizedUrl);
  await transaction.waitForReadiness();
  assertCurrent(transaction.isCurrent);
  if (!transaction.hasArtifact()) return;
  await transaction.exportPdf(authorizedUrl);
}
