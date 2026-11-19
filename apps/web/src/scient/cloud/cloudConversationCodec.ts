import { CloudConversation } from "@scientfactory/scient-cloud/api";
import * as Schema from "effect/Schema";

const decodeConversationJson = Schema.decodeUnknownSync(Schema.fromJsonString(CloudConversation));

async function pipeBytes(bytes: Uint8Array, stream: CompressionStream | DecompressionStream) {
  const body = new Blob([Uint8Array.from(bytes)]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(body).arrayBuffer());
}

export function gzipBytes(bytes: Uint8Array): Promise<Uint8Array> {
  return pipeBytes(bytes, new CompressionStream("gzip"));
}

function isGzip(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/** A stored conversation: gzip JSON, or JSON a server already decompressed in transit. */
export async function decodeCloudConversation(bytes: Uint8Array): Promise<CloudConversation> {
  const json = isGzip(bytes) ? await pipeBytes(bytes, new DecompressionStream("gzip")) : bytes;
  return decodeConversationJson(new TextDecoder().decode(json));
}
