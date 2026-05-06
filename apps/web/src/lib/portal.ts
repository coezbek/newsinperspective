/**
 * Move a node to <body> so it escapes any ancestor that creates a containing
 * block for fixed-position descendants (e.g. via `backdrop-filter`, `filter`,
 * or `transform`). Required for tooltips/popovers that should be positioned
 * against the viewport.
 */
export function portal(node: HTMLElement) {
  document.body.appendChild(node);
  return {
    destroy() {
      node.remove();
    },
  };
}
