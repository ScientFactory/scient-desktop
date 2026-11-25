import { expect, it } from "vite-plus/test";

import { createTesseractOcrEngine } from "./pdfOcrEngine";

it("recognizes printed words with the worker and language files served by the app", async () => {
  const canvas = document.createElement("canvas");
  canvas.width = 900;
  canvas.height = 240;
  const context = canvas.getContext("2d")!;
  context.fillStyle = "white";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.font = "40px sans-serif";
  context.fillStyle = "black";
  context.fillText("Clinical research report", 64, 105);
  const image = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Could not render sample")))),
  );
  const lines = await createTesseractOcrEngine(1).recognize(image, canvas);
  const words = lines.flatMap((line) => line.words);
  expect(words.map((word) => word.text).join(" ")).toContain("Clinical research report");
  const research = words.find((word) => word.text === "research")!;
  expect(research.box.x1).toBeGreaterThan(research.box.x0);
});
