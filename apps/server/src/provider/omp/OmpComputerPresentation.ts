import type { ToolActivityIcon, ToolActivitySource, ToolHostPermission } from "@t3tools/contracts";
import { COMPUTER_USE_TOOL_SOURCE } from "@t3tools/shared/toolActivity";
import {
  MAX_TOOL_OUTPUT_IMAGE_BASE64_LENGTH,
  MAX_TOOL_OUTPUT_IMAGES,
  readToolOutputImage,
} from "@t3tools/shared/toolOutput";

/** The agent drives the desktop through its Eval tool's `computer` prelude (JavaScript or Python). */
const EVAL_TOOL = "eval";
const COMPUTER_CALL = /(?:^|[^\w.$])computer\s*\.\s*[A-Za-z_]/u;
/** `{ app: "TextEdit" }` in JavaScript, `app="TextEdit"` in Python, `{"app":"TextEdit"}` in a status. */
const APP_ARGUMENT = /(?:^|[^\w$])app["']?\s*[:=]\s*(["'])([^"'\r\n]{1,160})\1/u;
const OPENED_APP = /\bapps\s*\.\s*open\s*\(\s*(["'])([^"'\r\n]{1,160})\1/u;
const MAX_TITLE_LENGTH = 160;

export interface OmpComputerPresentation {
  readonly title: string;
  readonly toolSurface: "computer";
  readonly toolSource: ToolActivitySource;
  readonly toolIcon?: ToolActivityIcon;
}

export interface OmpToolImage {
  readonly mimeType: string;
  readonly data: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const trimmed = (value: unknown, max: number): string | undefined => {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text.length > 0 && text.length <= max ? text : undefined;
};

/** An item to open rather than an application: a path, a URL, or a file name. */
const looksLikeItem = (value: string) => /[/\\~:]|\.[A-Za-z0-9]{1,5}$/u.test(value);

const targetApp = (code: string): string | undefined => {
  const named = APP_ARGUMENT.exec(code)?.[2]?.trim();
  if (named) return named;
  const opened = OPENED_APP.exec(code)?.[2]?.trim();
  return opened && !looksLikeItem(opened) ? opened : undefined;
};

const sourceKey = (app: string) =>
  `native-app-name:${app
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "")}`;

/** The prelude reports each desktop call as an `op: "computer"` status, handles included. */
const computerStatusEvents = (result: unknown): ReadonlyArray<Record<string, unknown>> => {
  const details = isRecord(result) && isRecord(result.details) ? result.details : undefined;
  return Array.isArray(details?.statusEvents)
    ? details.statusEvents.filter(
        (event): event is Record<string, unknown> => isRecord(event) && event.op === "computer",
      )
    : [];
};

/** What the agent said about the desktop calls that failed. */
export const ompComputerStatusErrors = (result: unknown): ReadonlyArray<string> =>
  computerStatusEvents(result).flatMap((event) =>
    typeof event.error === "string" ? [event.error] : [],
  );

/** Eval calls that use the desktop read as computer use, named after the app they target. */
export const ompComputerPresentation = (
  name: string,
  input: unknown,
  result?: unknown,
  /** Every string shown comes through this, as the call's own input and output do. */
  redact: (text: string) => string = (text) => text,
): OmpComputerPresentation | undefined => {
  if (name !== EVAL_TOOL) return undefined;
  const code = isRecord(input) && typeof input.code === "string" ? redact(input.code) : "";
  const statuses = computerStatusEvents(result);
  if (!COMPUTER_CALL.test(code) && statuses.length === 0) return undefined;
  const calls = statuses.flatMap((event) =>
    typeof event.detail === "string" ? [redact(event.detail)] : [],
  );
  const app = targetApp(code) ?? calls.map(targetApp).find((found) => found !== undefined);
  const title =
    (isRecord(input) && typeof input.title === "string"
      ? trimmed(redact(input.title), MAX_TITLE_LENGTH)
      : undefined) ?? (app ? `Use ${app}` : "Computer use");
  if (!app) return { title, toolSurface: "computer", toolSource: COMPUTER_USE_TOOL_SOURCE };
  const icon = { _tag: "native-app", app: { _tag: "display-name", displayName: app } } as const;
  return {
    title,
    toolSurface: "computer",
    toolIcon: icon,
    toolSource: { key: sourceKey(app), name: app, kind: "computer", icon },
  };
};

/** A later frame of the same call carries no arguments; it keeps the presentation it had. */
export const retainedComputerPresentation = (
  previous:
    | {
        readonly title?: string;
        readonly toolSurface?: string;
        readonly toolSource?: ToolActivitySource;
        readonly toolIcon?: ToolActivityIcon;
      }
    | undefined,
): OmpComputerPresentation | undefined =>
  previous?.toolSurface === "computer" && previous.title && previous.toolSource
    ? {
        title: previous.title,
        toolSurface: "computer",
        toolSource: previous.toolSource,
        ...(previous.toolIcon ? { toolIcon: previous.toolIcon } : {}),
      }
    : undefined;

/** The images a tool result shows, as the timeline serves them: its image blocks, then the pictures `generate_image` made. */
export const ompToolImages = (result: unknown): ReadonlyArray<OmpToolImage> => {
  if (!isRecord(result)) return [];
  const generated =
    isRecord(result.details) && Array.isArray(result.details.images)
      ? result.details.images.map((image) =>
          isRecord(image) ? { ...image, type: "image" } : image,
        )
      : [];
  const images: Array<OmpToolImage> = [];
  for (const block of [...(Array.isArray(result.content) ? result.content : []), ...generated]) {
    const image = readToolOutputImage(block);
    if (image?.data === undefined || image.data.length > MAX_TOOL_OUTPUT_IMAGE_BASE64_LENGTH)
      continue;
    images.push({ mimeType: image.mimeType, data: image.data });
    if (images.length === MAX_TOOL_OUTPUT_IMAGES) break;
  }
  return images;
};

/** The agent's macOS denial: "macOS <pane> permission is not granted to <app>, …". */
const PERMISSION_DENIED = /macOS ([A-Za-z& ]{1,64}?) permission is not granted/gu;

/** The privacy panes a computer call was refused for, read from what the agent reported. */
export const ompComputerPermissionsNeeded = (
  text: string | undefined,
): ReadonlyArray<ToolHostPermission> => {
  if (!text) return [];
  const needed = new Set<ToolHostPermission>();
  for (const [, pane] of text.matchAll(PERMISSION_DENIED)) {
    if (/recording/iu.test(pane ?? "")) needed.add("screen-recording");
    else if (/accessibility/iu.test(pane ?? "")) needed.add("accessibility");
  }
  return [...needed];
};
