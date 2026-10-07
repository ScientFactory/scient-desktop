import * as Schema from "effect/Schema";

const encodeOmpJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

/** A short size for limit messages: 10 MB, 1.2 MB, 512 KB. */
export const formatOmpBytes = (bytes: number): string =>
  bytes >= 1024 * 1024
    ? `${Number((bytes / (1024 * 1024)).toFixed(1))} MB`
    : `${Math.ceil(bytes / 1024)} KB`;

/** Room for the numeric request id the client adds to every command. */
const OMP_FRAME_ID_RESERVE = encodeOmpJson({ id: "9".repeat(20) }).length;

export interface OmpImageAttachment {
  readonly path: string;
  readonly size: number;
  readonly mimeType: string;
}

/**
 * Exact JSONL bytes of a prompt (or steer) frame with this message and no
 * images, including the request id and newline the client adds.
 */
const ompBaseFrameBytes = (message: string): number =>
  Buffer.byteLength(encodeOmpJson({ type: "follow_up", message })) + OMP_FRAME_ID_RESERVE + 1;

/** Bytes one inline image adds to a frame: its JSON object, base64 data, and separator. */
const ompInlineImageBytes = (image: OmpImageAttachment): number =>
  Buffer.byteLength(encodeOmpJson({ type: "image", data: "", mimeType: image.mimeType })) +
  4 * Math.ceil(image.size / 3) +
  1;

/** `,"images":[]` around the inline images. */
const OMP_IMAGES_ARRAY_BYTES = Buffer.byteLength(',"images":[]');

/**
 * Decide which images travel inline and which as attached local files. Inline
 * images must fit, with the message, in the physical frame OMP advertised in
 * `ready.maxFrameBytes` (OMP reads commands unchunked). Images that do not fit
 * are listed as local files instead: OMP 18.3.1's `read` tool returns image
 * content for image files to image-capable models, which reaches the next
 * model request. Moving an image to a file lengthens the message, so the plan
 * is recomputed until it is stable.
 */
export const planOmpImages = (input: {
  readonly buildMessage: (imageFiles: ReadonlyArray<string>) => string;
  readonly images: ReadonlyArray<OmpImageAttachment>;
  readonly maxFrameBytes: number;
}):
  | {
      readonly message: string;
      readonly inline: ReadonlyArray<OmpImageAttachment>;
    }
  | { readonly messageBytes: number } => {
  const viaFile = new Set<OmpImageAttachment>();
  while (true) {
    const message = input.buildMessage(
      input.images.filter((image) => viaFile.has(image)).map((image) => image.path),
    );
    const base = ompBaseFrameBytes(message);
    if (base > input.maxFrameBytes) return { messageBytes: base };
    const inline: Array<OmpImageAttachment> = [];
    let used = base + OMP_IMAGES_ARRAY_BYTES;
    let moved = false;
    for (const image of input.images) {
      if (viaFile.has(image)) continue;
      const cost = ompInlineImageBytes(image);
      if (used + cost <= input.maxFrameBytes) {
        inline.push(image);
        used += cost;
      } else {
        viaFile.add(image);
        moved = true;
      }
    }
    if (!moved) return { message, inline };
  }
};
