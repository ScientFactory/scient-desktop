import { expect, it, vi } from "vite-plus/test";
import {
  connectLessonTalk,
  LESSON_TALK_MODEL,
  lessonContext,
  lessonInstructions,
} from "./lessonTalk.ts";

const captions = [
  { window: 0, start: 0, end: 12, text: "Entropy always increases." },
  { window: 1, start: 65, end: 80, text: "This is the second law." },
];

it("sends the latest whole captions that fit, and says when earlier ones were left out", () => {
  expect(lessonContext(captions)).toEqual({
    text: "[00:00] Entropy always increases.\n[01:05] This is the second law.",
    clipped: false,
  });
  expect(lessonContext(captions, 40)).toEqual({
    text: "[01:05] This is the second law.",
    clipped: true,
  });
  const instructions = lessonInstructions(captions);
  expect(instructions).toContain("<lesson_captions>\n[00:00] Entropy always increases.");
  expect(instructions).not.toContain("Only the most recent part");
  expect(lessonInstructions([])).toContain("(No captions yet.)");
});

it("places the call with the key on the server and returns OpenAI's answer", async () => {
  const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    Response.json({}, { status: 200 }),
  );
  fetch.mockResolvedValueOnce(new Response("v=0\r\nanswer", { status: 201 }));
  const answer = await connectLessonTalk({
    key: "synthetic-key",
    sdpOffer: "v=0\r\noffer",
    instructions: "Answer briefly.",
    signal: AbortSignal.timeout(1000),
    fetch: fetch as typeof globalThis.fetch,
  });
  expect(answer).toBe("v=0\r\nanswer");
  const [url, init] = fetch.mock.calls[0]!;
  expect(url).toBe("https://api.openai.com/v1/realtime/calls");
  expect(init?.headers).toEqual({ Authorization: "Bearer synthetic-key" });
  const form = init?.body as FormData;
  expect(form.get("sdp")).toBe("v=0\r\noffer");
  expect(JSON.parse(String(form.get("session")))).toMatchObject({
    type: "realtime",
    model: LESSON_TALK_MODEL,
    instructions: "Answer briefly.",
  });

  fetch.mockResolvedValueOnce(new Response("no", { status: 401 }));
  await expect(
    connectLessonTalk({
      key: "synthetic-key",
      sdpOffer: "v=0",
      instructions: "",
      signal: AbortSignal.timeout(1000),
      fetch: fetch as typeof globalThis.fetch,
    }),
  ).rejects.toMatchObject({ reason: "rejected-key" });
});
