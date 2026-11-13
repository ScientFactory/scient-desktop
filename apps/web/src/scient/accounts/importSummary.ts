import {
  BrowserImportUnavailableReason,
  type BrowserImportFailureReason,
  type BrowserImportResult,
  type BrowserImportSourceId,
} from "@t3tools/contracts";

import { countBucket, type AccountBrowserEvents } from "../analytics/accountBrowserAnalytics";

/** Cookie rows an import read, by what became of them; never a count of sites. */
type ImportSummary = Pick<BrowserImportResult, "imported" | "skipped" | "skippedByReason">;

/** An import's outcome as the import surfaces report it. */
type ImportReport = (
  | {
      readonly kind: "imported";
      readonly imported: number;
      readonly skipped: number;
      readonly importedUnit?: "signIns";
      readonly partial?: true;
    }
  | {
      readonly kind: "blocked";
      readonly reason: BrowserImportFailureReason;
      /** A refusal in its own words, such as a managed policy's. */
      readonly message?: string;
    }
) & {
  /** Windows app-bound cookie rows left behind. */
  readonly protectedSkipped?: number;
};

/**
 * Why an import that wrote nothing still failed: cookies it couldn't read make it a refusal, not
 * an empty profile. Undefined when it wrote something, or there was nothing to read.
 */
export function importShortfall(summary: ImportSummary): BrowserImportFailureReason | undefined {
  if (summary.imported > 0) return undefined;
  const by = summary.skippedByReason;
  if ((by?.appBoundEncryption ?? 0) > 0) return "appBoundEncryption";
  if ((by?.decryptFailed ?? 0) > 0) return "readFailed";
  return (by?.partitionUnsupported ?? 0) + (by?.writeFailed ?? 0) > 0 ? "writeFailed" : undefined;
}

/** What a partial import says about the protected cookies it left behind. */
export function protectedNotice(count: number | undefined): string | undefined {
  if (!count) return undefined;
  const cookies =
    count === 1 ? "1 protected cookie" : `${count.toLocaleString()} protected cookies`;
  return `${cookies} couldn't be copied; some sites may need sign-in.`;
}

const UNAVAILABLE: ReadonlySet<string> = new Set(BrowserImportUnavailableReason.literals);

/** One import or refresh, as fixed codes and buckets. */
export function browserImportEvent(
  sourceBrowser: BrowserImportSourceId,
  report: ImportReport,
): AccountBrowserEvents["accounts.browser_import"] {
  const protectedSkipped = countBucket(report.protectedSkipped ?? 0);
  if (report.kind === "blocked")
    return {
      variant:
        report.message !== undefined || UNAVAILABLE.has(report.reason) ? "blocked" : "failed",
      sourceBrowser,
      importedUnit: "cookies",
      importedBucket: countBucket(0),
      protectedSkipped,
    };
  return {
    variant: report.skipped > 0 || report.partial ? "partial" : "complete",
    sourceBrowser,
    importedUnit: report.importedUnit === "signIns" ? "sign_ins" : "cookies",
    importedBucket: countBucket(report.imported),
    protectedSkipped,
  };
}
