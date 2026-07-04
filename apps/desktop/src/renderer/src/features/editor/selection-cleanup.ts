export function pruneLandedInFlightSelectionIds(
  inFlight: ReadonlySet<string>,
  alive: ReadonlySet<string>
): Set<string> {
  if (inFlight.size === 0) return new Set();
  const next = new Set<string>();
  for (const id of inFlight) {
    if (!alive.has(id)) next.add(id);
  }
  return next;
}

export function filterSelectionToAliveOrInFlight(
  selectedLayerIds: readonly string[],
  alive: ReadonlySet<string>,
  inFlight: ReadonlySet<string>
): readonly string[] {
  if (selectedLayerIds.length === 0) return selectedLayerIds;
  const filtered = selectedLayerIds.filter((id) => alive.has(id) || inFlight.has(id));
  return filtered.length === selectedLayerIds.length ? selectedLayerIds : filtered;
}
