export type ChatDraftSurface = "library" | "sizzle";

export type ChatDraftSnapshot = { text: string; revision: number };

export type ChatDraftMove = {
  revision: number;
  sourceRevision: number | null;
};

const drafts = new Map<string, ChatDraftSnapshot>();
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

export function readChatDraftSnapshot(key: string): ChatDraftSnapshot | null {
  const entry = drafts.get(key);
  return entry === undefined ? null : { ...entry };
}

export function writeChatDraft(key: string, text: string): number {
  const revision = nextRevision++;
  if (text.length === 0) drafts.delete(key);
  else drafts.set(key, { text, revision });
  return revision;
}

export function moveChatDraft(
  fromKey: string,
  toKey: string,
  fallbackText: string
): ChatDraftMove {
  const source = drafts.get(fromKey);
  const text = source?.text ?? fallbackText;
  drafts.delete(fromKey);
  return {
    revision: writeChatDraft(toKey, text),
    sourceRevision: source?.revision ?? null
  };
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
