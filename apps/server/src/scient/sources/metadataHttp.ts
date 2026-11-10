// @effect-diagnostics nodeBuiltinImport:off -- Registry metadata lookups use bounded HTTPS requests.
import * as NodeHttps from "node:https";

const METADATA_TIMEOUT_MS = 5_000;
const MAX_METADATA_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_METADATA_REDIRECTS = 4;

export const METADATA_USER_AGENT =
  "Scient/0.0 (https://github.com/ScientFactory/scient-desktop; source metadata resolution)";

export interface MetadataResponse {
  readonly status: number;
  /** Empty unless the final status is 2xx. */
  readonly body: string;
  readonly url: URL;
}

export type MetadataRequest = (
  url: URL,
  headers: Readonly<Record<string, string>>,
) => Promise<MetadataResponse>;

export const requestMetadata: MetadataRequest = (url, headers) => requestFollowing(url, headers, 0);

function requestFollowing(
  url: URL,
  headers: Readonly<Record<string, string>>,
  redirects: number,
): Promise<MetadataResponse> {
  if (url.protocol !== "https:") {
    return Promise.reject(new Error("Metadata requests must use HTTPS."));
  }
  if (redirects > MAX_METADATA_REDIRECTS) {
    return Promise.reject(new Error("The metadata service redirected too many times."));
  }
  return new Promise((resolve, reject) => {
    const request = NodeHttps.get(url, { headers }, (response) => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        void requestFollowing(new URL(response.headers.location, url), headers, redirects + 1).then(
          resolve,
          reject,
        );
        return;
      }
      if (status < 200 || status >= 300) {
        response.resume();
        resolve({ status, body: "", url });
        return;
      }
      const chunks: Buffer[] = [];
      let length = 0;
      response.on("data", (chunk: Buffer) => {
        length += chunk.byteLength;
        if (length > MAX_METADATA_RESPONSE_BYTES) {
          request.destroy(new Error("The metadata service returned too much data."));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () =>
        resolve({ status, body: Buffer.concat(chunks).toString("utf8"), url }),
      );
    });
    request.setTimeout(METADATA_TIMEOUT_MS, () => {
      request.destroy(new Error("The metadata request timed out."));
    });
    request.on("error", reject);
  });
}

export async function requestMetadataText(
  url: URL,
  headers: Readonly<Record<string, string>>,
): Promise<string> {
  const response = await requestMetadata(url, headers);
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`The metadata service returned HTTP ${response.status}.`);
  }
  return response.body;
}

export async function requestMetadataJson(
  url: URL,
  headers: Readonly<Record<string, string>>,
): Promise<unknown> {
  return JSON.parse(await requestMetadataText(url, headers)) as unknown;
}
