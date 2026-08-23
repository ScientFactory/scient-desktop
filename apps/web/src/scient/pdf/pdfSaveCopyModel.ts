import type { AssetCopyResult } from "@scientfactory/document-artifacts";

export type PdfSaveCopyPresentation =
  | { readonly _tag: "none"; readonly refreshSource: false }
  | {
      readonly _tag: "notice";
      readonly type: "success" | "error";
      readonly title: string;
      readonly description?: string;
      readonly refreshSource: boolean;
    };

export function presentPdfSaveCopyResult(result: AssetCopyResult): PdfSaveCopyPresentation {
  switch (result._tag) {
    case "saved":
      return {
        _tag: "notice",
        type: "success",
        title: "PDF saved",
        description: result.path,
        refreshSource: false,
      };
    case "download-started":
      return {
        _tag: "notice",
        type: "success",
        title: "PDF download started",
        refreshSource: false,
      };
    case "cancelled":
      return { _tag: "none", refreshSource: false };
    case "failed":
      switch (result.reason) {
        case "dialog-failed":
          return {
            _tag: "notice",
            type: "error",
            title: "The Save dialog could not be opened",
            refreshSource: false,
          };
        case "source-unavailable":
          return {
            _tag: "notice",
            type: "error",
            title: "The PDF is no longer available",
            description: "Refresh the PDF and try again.",
            refreshSource: true,
          };
        case "source-changed":
          return {
            _tag: "notice",
            type: "error",
            title: "The PDF changed before it could be saved",
            description: "Scient refreshed the PDF. Try saving again.",
            refreshSource: true,
          };
        case "network-failed":
          return {
            _tag: "notice",
            type: "error",
            title: "The PDF could not be downloaded",
            description: "Check the environment connection and try again.",
            refreshSource: false,
          };
        case "write-failed":
          return {
            _tag: "notice",
            type: "error",
            title: "The PDF could not be saved",
            description: "Choose another location or check its permissions.",
            refreshSource: false,
          };
      }
  }
}
