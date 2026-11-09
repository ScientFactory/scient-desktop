import type { TiffPreviewInfo } from "./tiffPreview";

export interface TiffWorkerRequest {
  readonly id: number;
  readonly src: string;
  readonly plane: number;
}

export type TiffWorkerResult =
  | { readonly id: number; readonly blob: Blob; readonly info: TiffPreviewInfo }
  | { readonly id: number; readonly error: string; readonly kind: "format" | "load" };
