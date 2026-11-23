import Foundation

// Match the exact text of one evidence line. An approximate match could
// publish a label or reference that was never visible in the capture.
func groundedSearchText(anchors: [String], evidence: String) -> String {
  let lines = evidence.split(whereSeparator: \.isNewline)
  var seen = Set<String>()
  var snippets = [String]()
  for anchor in anchors {
    let snippet = anchor.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !snippet.isEmpty, snippet.utf8.count <= 120,
          snippet.rangeOfCharacter(from: .controlCharacters.union(.newlines)) == nil,
          lines.contains(where: { $0.range(of: snippet, options: .literal) != nil }),
          seen.insert(snippet).inserted else { continue }
    snippets.append(snippet)
    if snippets.count == 5 { break }
  }
  return snippets.joined(separator: "\n")
}
