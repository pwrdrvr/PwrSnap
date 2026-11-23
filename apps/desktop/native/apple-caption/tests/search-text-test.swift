import Foundation

@main
struct SearchTextTest {
  static func main() {
    let exact = String(repeating: "é", count: 60)
    let oversized = exact + "é"
    let evidence = "Reference: Zephyr 2749\nReady for review\n\(oversized)\nDraft\nInbox\nDone\nArchive\n\u{0000}Review"

    expect(["Zephyr 2749", " Zephyr 2749 ", "zephyr 2749", "Made-up reference", "Draft\nInbox"],
           evidence, "Zephyr 2749")
    expect(["Zephyr 2749"], "", "")
    expect([], evidence, "")
    expect([oversized, "   ", "\u{0000}Review"], evidence, "")
    expect([exact, "Zephyr 2749", "Ready for review", "Draft", "Inbox", "Done", "Archive"],
           evidence, [exact, "Zephyr 2749", "Ready for review", "Draft", "Inbox"].joined(separator: "\n"))
  }

  static func expect(_ anchors: [String], _ evidence: String, _ expected: String) {
    let actual = groundedSearchText(anchors: anchors, evidence: evidence)
    guard actual == expected else {
      FileHandle.standardError.write(Data("Expected \(expected.debugDescription), got \(actual.debugDescription)\n".utf8))
      exit(1)
    }
  }
}
