export type ChatDraftSurface = "library" | "sizzle";

type DraftEntry = { text: string; revision: number };

const drafts = new Map<string, DraftEntry>();
let nextRevision = 1;

export function chatDraftKey(
  surface: ChatDraftSurface,
  scopeId: string | null,
  threadId: string | null
): string {
  return JSON.stringify([surface, scopeId, threadId ?? "__new__"]);
}

export function readChatDraft(key: string): string {
  return drafts.get(key)?.text ?? "";
}

export function writeChatDraft(key: string, text: string): number {
  const revision = nextRevision++;
  if (text.length === 0) drafts.delete(key);
  else drafts.set(key, { text, revision });
  return revision;
}

export function moveChatDraft(fromKey: string, toKey: string, fallbackText: string): number {
  const text = drafts.get(fromKey)?.text ?? fallbackText;
  drafts.delete(fromKey);
  return writeChatDraft(toKey, text);
}

export function clearChatDraftAtRevision(key: string, revision: number): boolean {
  if (drafts.get(key)?.revision !== revision) return false;
  drafts.delete(key);
  return true;
}

export function clearChatDraftsForTests(): void {
  drafts.clear();
  nextRevision = 1;
}
