import Foundation

@main
struct SearchTextTest {
  static func main() throws {
    let exact = String(repeating: "é", count: 60)
    let oversized = exact + "é"
    let lines = ["Reference: Zephyr 2749", "Ready for review", oversized, "Draft", "Inbox", "Done", "Archive", "\u{0000}Review"]

    try expectPublication(["Zephyr 2749", " Zephyr 2749 ", "zephyr 2749", "Made-up reference", "Draft\nInbox"],
                          lines, "Zephyr 2749")
    try expectPublication(["Zephyr 2749"], [], "")
    try expectPublication([], lines, "")
    try expectPublication([oversized, "   ", "\u{0000}Review"], lines, "")
    try expectPublication([exact, "Zephyr 2749", "Ready for review", "Draft", "Inbox", "Done", "Archive"],
                          lines, [exact, "Zephyr 2749", "Ready for review", "Draft", "Inbox"].joined(separator: "\n"))
    try expectPublication(["main.swift", "ID-6"], ["main.swift", "func runCaptionCommand()", "ID-6"], "main.swift\nID-6")

    // A reference may fall at any position relative to the evidence budget.
    let reference = "Report ref: AB-2719"
    for room in 0...reference.count {
      let padding = String(repeating: "x", count: 3_499 - room)
      if room == reference.count {
        try expectPublication(["AB-2719"], [padding, reference], "AB-2719")
      } else {
        try expectPublication(["AB-2719", "AB-27"], [padding, reference], "")
      }
    }
    try expectPublication(["main.swift"], [String(repeating: "x", count: 3_501), "main.swift"], "main.swift")

    let credentialLines = [
      "Password: synthetic secret phrase", "Access Token\nfixtureToken2749", "export API_KEY='fixtureAPI42'",
      "Repeat fixtureToken2749 here", "Fingerprint fixtureAPI42 here", "Password policy", "main.swift"
    ]
    try expectPublication(["synthetic secret phrase", "fixtureToken2749", "Token2749", "fixtureAPI42", "Password policy", "main.swift"],
                          credentialLines, "Password policy\nmain.swift")
    expect(CaptionOCREvidence(lines: credentialLines).text == "Password policy\nmain.swift", "credential evidence")
  }

  static func expectPublication(_ anchors: [String], _ lines: [String], _ expected: String) throws {
    let evidence = CaptionOCREvidence(lines: lines)
    expect(evidence.text.count <= 3_500, "evidence budget")
    let caption = PublishedCaption(title: "Fixture title", description: "Fixture description", filenameStem: "fixture",
                                   tags: [["label": "sample"]], anchors: anchors, ocrEvidence: evidence)
    let encoded = try JSONEncoder().encode(caption)
    let actual = try JSONSerialization.jsonObject(with: encoded) as? NSDictionary
    let output: NSDictionary = [
      "title": "Fixture title", "description": "Fixture description", "filenameStem": "fixture",
      "tags": [["label": "sample"]], "ocrText": expected
    ]
    expect(actual == output, "expected OCR \(expected.debugDescription), got \(String(describing: actual?["ocrText"]))")
  }

  static func expect(_ condition: Bool, _ message: String) {
    guard condition else {
      FileHandle.standardError.write(Data((message + "\n").utf8))
      exit(1)
    }
  }
}
