import {
  AgentFileAttachmentSource,
  ChatFileAttachment,
  ChatImageAttachment,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";

// Keep screenshot provenance in app metadata; its recursive tree breaks model tool schemas.
export const McpAttachmentInput = Schema.Union([
  ChatImageAttachment.mapFields(Struct.omit(["source"])),
  // Session provenance belongs to the stored attachment. A forward resolves it by ID.
  ChatFileAttachment.mapFields((fields) => ({
    ...fields,
    source: Schema.optional(AgentFileAttachmentSource),
  })),
]);
