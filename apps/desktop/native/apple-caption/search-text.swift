import Foundation

struct CaptionOCREvidence {
  let text: String

  init(lines: [String]) {
    let lines = lines.flatMap { $0.split(whereSeparator: \.isNewline) }
      .map(String.init)
      .filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
    var eligibleLines = [String]()
    var credentials = Set<String>()
    var expectsValue = false
    for line in lines {
      if let value = labeledCredential(in: line) {
        expectsValue = value.isEmpty
        if !expectsValue { credentials.insert(value) }
      } else if expectsValue {
        credentials.insert(line.trimmingCharacters(in: .whitespacesAndNewlines.union(credentialQuotes)))
        expectsValue = false
      } else {
        eligibleLines.append(line)
      }
    }

    // Drop complete lines that would exceed the budget. A partial line can
    // turn a complete filename or reference into a misleading search term.
    var remaining = 3_500
    var boundedLines = [String]()
    for line in eligibleLines {
      let length = line.count + (boundedLines.isEmpty ? 0 : 1)
      guard length <= remaining,
            !credentials.contains(where: { !$0.isEmpty && line.range(of: $0, options: .literal) != nil }) else { continue }
      boundedLines.append(line)
      remaining -= length
    }
    text = boundedLines.joined(separator: "\n")
  }
}

private let credentialQuotes = CharacterSet(charactersIn: "\"'`“”‘’")
private let credentialLabels: Set<String> = [
  "password", "passphrase", "access token", "refresh token", "api token", "api key", "client secret"
]

// An empty value indicates a standalone credential label. Vision can
// recognize a form's label and its value as separate observations.
private func labeledCredential(in line: String) -> String? {
  let parts = line.split(maxSplits: 1, omittingEmptySubsequences: false) { $0 == ":" || $0 == "=" }
  let label = parts[0].lowercased().trimmingCharacters(in: .whitespaces.union(credentialQuotes))
  let words = label.split(whereSeparator: { $0.isWhitespace || $0 == "_" || $0 == "-" })
  let name = words.first == "export" ? words.dropFirst().joined(separator: " ") : words.joined(separator: " ")
  guard credentialLabels.contains(name) else { return nil }
  return parts.count == 1 ? "" : parts[1].trimmingCharacters(in: .whitespaces.union(credentialQuotes))
}

struct PublishedCaption<Tag: Encodable>: Encodable {
  let title: String
  let description: String
  let filenameStem: String
  let tags: [Tag]
  let ocrText: String

  init(title: String, description: String, filenameStem: String, tags: [Tag],
       anchors: [String], ocrEvidence: CaptionOCREvidence) {
    self.title = title
    self.description = description
    self.filenameStem = filenameStem
    self.tags = tags
    ocrText = groundedSearchText(anchors: anchors, evidence: ocrEvidence.text)
  }
}

// Match the exact text of one evidence line. An approximate match could
// publish a label or reference that was never visible in the capture.
private func groundedSearchText(anchors: [String], evidence: String) -> String {
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
