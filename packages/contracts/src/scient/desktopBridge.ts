import {
  AssetCopyRequest,
  AssetCopyResult,
  type AssetCopyRequest as AssetCopyRequestType,
  type AssetCopyResult as AssetCopyResultType,
} from "@scientfactory/document-artifacts";

import type {
  DesktopConversationFileReleaseRequest,
  DesktopConversationFileUploadCancelRequest,
  DesktopConversationFileUploadRequest,
  DesktopConversationFileUploadResult,
  DesktopOpenedConversationFile,
} from "../scientConversationImport.ts";
import type {
  DesktopDocumentPageRenderInput,
  DesktopDocumentPageRenderOutcome,
} from "../scientDocumentExport.ts";
import type { DesktopVoiceBridge } from "./desktopVoiceBridge.ts";

export const DesktopAssetCopyRequestSchema = AssetCopyRequest;
export type DesktopAssetCopyRequest = AssetCopyRequestType;
export const DesktopAssetCopyResultSchema = AssetCopyResult;
export type DesktopAssetCopyResult = AssetCopyResultType;

/** Scient members of the desktop bridge; ipc.ts's DesktopBridge extends this interface. */
export interface ScientDesktopBridge {
  /** Scient: macOS conversations with unread completed answers; zero clears the badge. */
  setUnreadAnswerCount?: (count: number) => Promise<boolean>;
  // Conversation files the OS opened with Scient.
  /** Scient: removes and returns the `.scic` files opened with Scient that await import. */
  takeOpenedConversationFiles?: () => Promise<ReadonlyArray<DesktopOpenedConversationFile>>;
  /** Scient: called when the OS opens another `.scic` with Scient; then take them. */
  onConversationFilesOpened?: (listener: () => void) => () => void;
  /** Scient: streams an opened `.scic` to a signed import upload URL. */
  uploadOpenedConversationFile?: (
    request: DesktopConversationFileUploadRequest,
  ) => Promise<DesktopConversationFileUploadResult>;
  /** Scient: stops one upload attempt, or keeps it from starting; that attempt ends `cancelled`. */
  cancelOpenedConversationFileUpload?: (
    request: DesktopConversationFileUploadCancelRequest,
  ) => Promise<void>;
  /** Scient: gives up an opened `.scic`; its token then fails `file-unavailable`. */
  releaseOpenedConversationFile?: (request: DesktopConversationFileReleaseRequest) => Promise<void>;
  saveAssetCopy: (request: DesktopAssetCopyRequest) => Promise<DesktopAssetCopyResult>;
  /** Optional while older desktop shells can host a newer web client. */
  revealSavedAsset?: (path: string) => Promise<void>;
  /**
   * Print one captured Scient document page in a hidden, isolated window.
   * Optional while older desktop shells can host a newer web client.
   */
  renderDocumentPagePdf?: (
    input: DesktopDocumentPageRenderInput,
  ) => Promise<DesktopDocumentPageRenderOutcome>;
  /** Write an already-encoded PNG image to the native system clipboard. */
  copyPngToClipboard?: (png: Uint8Array) => Promise<void>;
  /** Optional while older desktop shells can host a newer web client. */
  reloadMainWindow?: (ignoreCache: boolean) => Promise<boolean>;
  /** Optional while older desktop shells can host a newer web client. */
  onReloadBlocked?: (listener: () => void) => () => void;
  /**
   * Desktop-only local voice transcription surface. Present iff the renderer is
   * hosted by the Electron desktop build; web builds have `voice === undefined`.
   */
  voice?: DesktopVoiceBridge;
}
