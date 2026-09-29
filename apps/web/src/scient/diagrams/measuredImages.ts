/** Stands in for an image a diagram names; transparent, 1×1. */
const PLACEHOLDER_IMAGE =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

/** The bytes are already here, or the reference stays inside the SVG. */
const isLocalAddress = (address: string) => /^\s*(?:#|data:|blob:)/iu.test(address);

/**
 * Loads made through `new Image()` in `target` (an image shape measuring its picture) get a
 * local stand-in, so the draw completes without its picture instead of failing on a refused
 * load. `onBlocked` receives each address replaced. Returns a function that gives the window
 * its own image loading back; the no-network frame keeps the stand-in for its lifetime, the
 * page restores it after each draw.
 */
export function substituteMeasuredImages(
  target: Window,
  onBlocked: (address: string) => void,
): () => void {
  const prototype = (target as Window & typeof globalThis).HTMLImageElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "src");
  if (!descriptor?.set || !descriptor.get) return () => undefined;
  const { get, set } = descriptor;
  Object.defineProperty(prototype, "src", {
    configurable: true,
    enumerable: descriptor.enumerable ?? true,
    get() {
      return get.call(this);
    },
    set(value: unknown) {
      const address = String(value);
      if (/^\s*(?:data|blob):/iu.test(address)) {
        set.call(this, address);
        return;
      }
      onBlocked(address);
      set.call(this, PLACEHOLDER_IMAGE);
    },
  });
  return () => {
    Object.defineProperty(prototype, "src", descriptor);
  };
}

const LINK_ATTRIBUTES = new Set(["href", "xlink:href"]);

/**
 * An SVG `<image>` given an outside address in `target` (an image shape's picture, a
 * sequence actor's icon) gets the stand-in instead, so drawing makes no request at all;
 * `onBlocked` receives the address. For the page, whose own policy lets its captured images
 * load; the frame's policy refuses such loads by itself. Returns a function that undoes it.
 */
export function substituteSvgImageLinks(
  target: Window,
  onBlocked: (address: string) => void,
): () => void {
  const scope = target as Window & typeof globalThis;
  const prototype = scope.SVGImageElement.prototype;
  const { setAttribute, setAttributeNS } = scope.Element.prototype;
  const replace = (name: string, value: unknown) => {
    const address = String(value);
    if (!LINK_ATTRIBUTES.has(name.toLowerCase()) || isLocalAddress(address)) return address;
    onBlocked(address);
    return PLACEHOLDER_IMAGE;
  };
  Object.defineProperty(prototype, "setAttribute", {
    configurable: true,
    writable: true,
    value(this: Element, name: string, value: unknown) {
      setAttribute.call(this, name, replace(name, value));
    },
  });
  Object.defineProperty(prototype, "setAttributeNS", {
    configurable: true,
    writable: true,
    value(this: Element, namespace: string | null, name: string, value: unknown) {
      setAttributeNS.call(this, namespace, name, replace(name, value));
    },
  });
  return () => {
    Reflect.deleteProperty(prototype, "setAttribute");
    Reflect.deleteProperty(prototype, "setAttributeNS");
  };
}
