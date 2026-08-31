/** PDF.js scroll/scale operations require a connected, laid-out page container. */
export function hasPdfLayout(container: HTMLDivElement, viewerElement: HTMLDivElement): boolean {
  return (
    container.isConnected &&
    viewerElement.isConnected &&
    container.clientWidth > 0 &&
    container.clientHeight > 0 &&
    viewerElement.offsetParent !== null
  );
}
