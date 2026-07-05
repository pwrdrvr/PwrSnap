const activeHotCpuSessionDirectoryNames = new Set<string>();

export function markHotCpuProfileSessionActive(directoryName: string): void {
  activeHotCpuSessionDirectoryNames.add(directoryName);
}

export function markHotCpuProfileSessionInactive(directoryName: string): void {
  activeHotCpuSessionDirectoryNames.delete(directoryName);
}

export function listActiveHotCpuProfileSessionDirectoryNames(): string[] {
  return [...activeHotCpuSessionDirectoryNames];
}

export function clearActiveHotCpuProfileSessionsForTests(): void {
  activeHotCpuSessionDirectoryNames.clear();
}
