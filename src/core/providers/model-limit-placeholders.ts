export const DISCOVERY_PLACEHOLDER_CONTEXT_WINDOW = 128000;
export const DISCOVERY_PLACEHOLDER_MAX_TOKENS = 8192;

export function preferCatalogLimit(
  stored: number | null | undefined,
  placeholder: number,
  catalog: number | undefined
): number | undefined {
  if (typeof stored !== "number" || !Number.isFinite(stored) || stored <= 0) return catalog;
  if (stored === placeholder && typeof catalog === "number" && catalog > placeholder) {
    return catalog;
  }
  return stored;
}
