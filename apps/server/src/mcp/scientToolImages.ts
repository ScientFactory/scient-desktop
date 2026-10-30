import * as Schema from "effect/Schema";
import { McpSchema } from "effect/ai";

interface ToolImage {
  readonly mediaType: string;
  readonly data: string;
}

const isCallToolResult = Schema.is(McpSchema.CallToolResult);

const isToolImage = (value: unknown): value is ToolImage =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as ToolImage).mediaType === "string" &&
  typeof (value as ToolImage).data === "string";

/**
 * A Scient tool may return figures in a top-level `images` field. Models only look at
 * MCP image content, so the figures move there and leave the JSON text small.
 */
export function liftScientToolImages<A>(result: A): A | McpSchema.CallToolResult {
  if (!isCallToolResult(result)) return result;
  const structured = result.structuredContent;
  if (result.isError === true || typeof structured !== "object" || structured === null)
    return result;
  const { images, ...rest } = structured as Record<string, unknown>;
  if (!Array.isArray(images)) return result;
  return new McpSchema.CallToolResult({
    isError: false,
    structuredContent: rest,
    content: [
      { type: "text", text: JSON.stringify(rest) },
      ...images.filter(isToolImage).map((image) => ({
        type: "image" as const,
        data: new Uint8Array(Buffer.from(image.data, "base64")),
        mimeType: image.mediaType,
      })),
    ],
  });
}
