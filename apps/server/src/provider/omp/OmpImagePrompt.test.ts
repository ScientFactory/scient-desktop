import { assert, it } from "@effect/vitest";
import { planOmpImages } from "./OmpImagePrompt.ts";

it("budgets Unicode, JSON escaping and several images against one physical frame", () => {
  const images = ["first", "second", "third"].map((path) => ({
    path,
    size: 9,
    mimeType: "image/png",
  }));
  const plan = planOmpImages({
    images,
    maxFrameBytes: 220,
    buildMessage: (files) => `שלום\n"quoted"\\${files.join(",")}`,
  });
  assert.isTrue("inline" in plan);
  if (!("inline" in plan)) return;
  assert.isAbove(plan.inline.length, 0);
  assert.isBelow(plan.inline.length, images.length);
  const frame = JSON.stringify({
    type: "follow_up",
    message: plan.message,
    id: "9".repeat(20),
    images: plan.inline.map((image) => ({
      type: "image",
      data: Buffer.alloc(image.size).toString("base64"),
      mimeType: image.mimeType,
    })),
  });
  assert.isAtMost(Buffer.byteLength(frame) + 1, 220);
  for (const image of images.filter((image) => !plan.inline.includes(image))) {
    assert.include(plan.message, image.path);
  }
});

it("rechecks the message budget after moving an image to a file", () => {
  const plan = planOmpImages({
    images: [{ path: "large.png", size: 900_000, mimeType: "image/png" }],
    maxFrameBytes: 200,
    buildMessage: (files) => (files.length === 0 ? "small" : "x".repeat(300)),
  });
  assert.isTrue("messageBytes" in plan);
  if ("messageBytes" in plan) assert.isAbove(plan.messageBytes, 300);
});
