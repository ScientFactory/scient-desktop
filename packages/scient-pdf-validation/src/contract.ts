export const PDF_VALIDATION_MAX_BYTES = 256 * 1024 * 1024;
export const PDF_VALIDATION_TIMEOUT_MS = 30_000;

export type PdfValidationProfile = "existing-load" | "producer-registration";

export type PdfValidationFailureReason =
  | "empty"
  | "too-large"
  | "invalid"
  | "password-protected"
  | "timed-out"
  | "worker-failed";

export type PdfValidationResult =
  | {
      readonly accepted: true;
      readonly classification: "valid";
      readonly pageCount: number;
      readonly profile: PdfValidationProfile;
      readonly warnings: ReadonlyArray<"blank-pages-allowed">;
    }
  | {
      readonly accepted: false;
      readonly classification: "rejected";
      readonly pageCount: null;
      readonly profile: PdfValidationProfile;
      readonly reason: PdfValidationFailureReason;
      readonly detail: string;
    };

export function rejectedPdf(
  profile: PdfValidationProfile,
  reason: PdfValidationFailureReason,
  detail: string,
): PdfValidationResult {
  return {
    accepted: false,
    classification: "rejected",
    pageCount: null,
    profile,
    reason,
    detail,
  };
}
