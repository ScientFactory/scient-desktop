/** Compatibility access to queue documents saved before native admission. */
export {
  QueueError,
  readQueue,
  writeQueue,
  suspendQueue,
  type QueueDocument,
} from "../../orchestration-v2/legacy/LegacyQueueLedger.ts";
