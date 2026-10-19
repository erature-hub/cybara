export const TOP_OVERLAY_Z_INDEX = 2147483647;

export interface InertableElement {
  inert: boolean;
}

export function makeSiblingsInert(
  siblings: Iterable<InertableElement>,
  keep: InertableElement
): () => void {
  const changed: InertableElement[] = [];
  for (const sibling of siblings) {
    if (sibling === keep || sibling.inert) continue;
    sibling.inert = true;
    changed.push(sibling);
  }
  return () => {
    for (const sibling of changed) sibling.inert = false;
  };
}
