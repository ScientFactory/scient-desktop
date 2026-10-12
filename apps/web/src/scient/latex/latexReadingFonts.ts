const failed = new WeakSet<FontFace>();
const loading = new WeakMap<FontFace, Promise<unknown>>();
const identities = new WeakMap<FontFace, number>();
let sequence = 0;

function identity(face: FontFace) {
  let value = identities.get(face);
  if (value === undefined) identities.set(face, (value = ++sequence));
  return value;
}

function readingFaces(element: HTMLElement) {
  const families = new Set(
    getComputedStyle(element)
      .fontFamily.split(",")
      .map((family) => family.trim().replace(/^["']|["']$/gu, "")),
  );
  return [...element.ownerDocument.fonts].filter((face) => {
    const family = face.family.replace(/^["']|["']$/gu, "");
    return family.startsWith("KaTeX_") || families.has(family);
  });
}

/** Load the bundled reading font pool before accepting geometry. Formula
 * variants discovered by later pages then use the same settled metrics.
 */
export function prepareLatexReadingFonts(element: HTMLElement) {
  return Promise.all(
    readingFaces(element).map((face) => {
      let promise = loading.get(face);
      if (!promise) {
        promise = new Promise<void>((resolve) => {
          const timeout = setTimeout(() => {
            failed.add(face);
            resolve();
          }, 2000);
          void face
            .load()
            .catch(() => {
              failed.add(face);
            })
            .finally(() => {
              clearTimeout(timeout);
              resolve();
            });
        });
        loading.set(face, promise);
      }
      return promise;
    }),
  );
}

export function latexReadingFontsReady(element: HTMLElement) {
  return readingFaces(element).every((face) => face.status === "loaded" || failed.has(face));
}

/** Unrelated UI fonts never change the editor's measurement generation. */
export function latexReadingFontKey(element: HTMLElement) {
  return JSON.stringify(
    [
      ...new Set(
        readingFaces(element).map((face) =>
          JSON.stringify([
            identity(face),
            face.family,
            face.style,
            face.weight,
            face.stretch,
            face.unicodeRange,
            face.status === "loaded" ? "loaded" : failed.has(face) ? "fallback" : "pending",
          ]),
        ),
      ),
    ].sort(),
  );
}

export function latexReadingFontEvent(element: HTMLElement, event: Event) {
  const faces = (event as FontFaceSetLoadEvent).fontfaces;
  return !faces || faces.some((face) => readingFaces(element).includes(face));
}
