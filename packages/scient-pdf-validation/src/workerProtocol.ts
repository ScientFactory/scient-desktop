import type { PdfValidationProfile, PdfValidationResult } from "./contract.ts";

export interface PdfValidationWorkerInput {
  readonly bytes: Uint8Array;
  readonly profile: PdfValidationProfile;
}

export type PdfValidationWorkerOutput =
  | { readonly _tag: "Success"; readonly result: PdfValidationResult }
  | { readonly _tag: "Failure" };
