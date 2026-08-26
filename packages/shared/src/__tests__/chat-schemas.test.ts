import { describe, expect, test } from "vitest";
import {
  CHAT_APPROVAL_DETAIL_MAX_BYTES,
  CHAT_APPROVAL_DETAIL_MAX_LINES,
  CHAT_APPROVAL_ID_MAX_BYTES,
  CHAT_APPROVAL_SUMMARY_MAX_BYTES,
  CHAT_APPROVAL_SUMMARY_MAX_LINES,
  chatApprovalResponseSchema,
  parseChatApprovalRequest
} from "../chat-schemas";

function utf8Bytes(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
  }
  return bytes;
}

describe("chat approval schemas", () => {
  test("sanitizes and bounds hostile backend display text", () => {
    const parsed = parseChatApprovalRequest({
      threadId: "thread-safe",
      turnId: "turn-safe",
      approvalId: "approval-safe",
      summary: `Run\u0000\u0007\u202e\n${"🙂".repeat(500)}`,
      detail: `${Array.from(
        { length: 80 },
        (_, index) => `line-${index}\u2066\u000b${"x".repeat(300)}`
      ).join("\r\n")}\u202c`
    });

    expect(parsed).not.toBeNull();
    expect(utf8Bytes(parsed!.summary)).toBeLessThanOrEqual(
      CHAT_APPROVAL_SUMMARY_MAX_BYTES
    );
    expect(parsed!.summary.split("\n")).toHaveLength(
      CHAT_APPROVAL_SUMMARY_MAX_LINES
    );
    expect(utf8Bytes(parsed!.detail ?? "")).toBeLessThanOrEqual(
      CHAT_APPROVAL_DETAIL_MAX_BYTES
    );
    expect((parsed!.detail ?? "").split("\n").length).toBeLessThanOrEqual(
      CHAT_APPROVAL_DETAIL_MAX_LINES
    );
    expect(`${parsed!.summary}${parsed!.detail ?? ""}`).not.toMatch(
      /[\u0000\u0007\u000b\u202e\u2066\u202c]/u
    );
  });

  test("rejects oversized, control, bidi, and malformed exact request IDs", () => {
    const base = {
      threadId: "thread-safe",
      turnId: "turn-safe",
      approvalId: "approval-safe",
      summary: "Approve?"
    };
    const hostileIds = [
      "x".repeat(CHAT_APPROVAL_ID_MAX_BYTES + 1),
      "🙂".repeat(CHAT_APPROVAL_ID_MAX_BYTES / 4 + 1),
      "id\u0000control",
      "id\u202ebidi",
      "id\nline"
    ];

    for (const hostileId of hostileIds) {
      expect(
        parseChatApprovalRequest({ ...base, approvalId: hostileId })
      ).toBeNull();
    }
  });

  test("bounds all response identity fields by UTF-8 bytes and safe characters", () => {
    const valid = {
      threadId: "t".repeat(CHAT_APPROVAL_ID_MAX_BYTES),
      turnId: "turn-safe",
      approvalId: "approval-safe",
      decision: "deny"
    };
    expect(chatApprovalResponseSchema.safeParse(valid).success).toBe(true);

    for (const field of ["threadId", "turnId", "approvalId"] as const) {
      expect(
        chatApprovalResponseSchema.safeParse({
          ...valid,
          [field]: "🙂".repeat(CHAT_APPROVAL_ID_MAX_BYTES / 4 + 1)
        }).success
      ).toBe(false);
      expect(
        chatApprovalResponseSchema.safeParse({
          ...valid,
          [field]: "safe\u2066spoofed"
        }).success
      ).toBe(false);
      expect(
        chatApprovalResponseSchema.safeParse({
          ...valid,
          [field]: "safe\u0000control"
        }).success
      ).toBe(false);
    }
  });
});
