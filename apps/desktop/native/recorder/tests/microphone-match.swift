// The name match the recorder uses to honour the selector's microphone pick.
// Pure string logic: no device, no AVCaptureSession, no TCC access.
import Foundation

func expect(_ condition: Bool, _ message: String) {
    if !condition {
        FileHandle.standardError.write(("FAIL: " + message + "\n").data(using: .utf8)!)
        exit(1)
    }
}

@main
struct MicrophoneMatch {
    static func main() {
        let names = ["Breakfast Cereal Mic", "Granola Interface", "Porridge Pod (2)"]

        expect(indexOfMicrophone(named: "Granola Interface", among: names) == 1, "exact name")
        expect(indexOfMicrophone(named: "Breakfast Cereal Mic (Built-in)", among: names) == 0, "Chromium transport tag")
        expect(indexOfMicrophone(named: "Granola Interface (1a2b:3c4d)", among: names) == 1, "Chromium USB id tag")
        expect(indexOfMicrophone(named: "Porridge Pod (2)", among: names) == 2, "a name that itself ends in a parenthesis")
        expect(indexOfMicrophone(named: "Porridge Pod (2) (Bluetooth)", among: names) == 2, "tag after a parenthesised name")
        expect(indexOfMicrophone(named: "Muesli Mic (USB)", among: names) == nil, "an absent device does not match")
        expect(indexOfMicrophone(named: "Granola", among: names) == nil, "a prefix is not a match")
        expect(indexOfMicrophone(named: "Granola Interface", among: [String]()) == nil, "no devices")

        // Exact beats stripped: "Oat Mic (USB)" must not resolve to "Oat Mic".
        let shadow = ["Oat Mic", "Oat Mic (USB)"]
        expect(indexOfMicrophone(named: "Oat Mic (USB)", among: shadow) == 1, "exact outranks a stripped match")

        // Chromium labels some inputs by their data source, not the device.
        let sourced = [
            MicrophoneCandidate(name: "Oat Desk Mic"),
            MicrophoneCandidate(name: "Meeting Audio", sourceName: "Meeting Audio Device"),
        ]
        expect(indexOfMicrophone(named: "Meeting Audio Device (Virtual)", among: sourced) == 1, "data source name, tagged")
        expect(indexOfMicrophone(named: "Meeting Audio Device", among: sourced) == 1, "data source name")
        // A device name still outranks another input's data source name.
        let both = [
            MicrophoneCandidate(name: "Bran Mic", sourceName: "Oat Desk Mic"),
            MicrophoneCandidate(name: "Oat Desk Mic"),
        ]
        expect(indexOfMicrophone(named: "Oat Desk Mic", among: both) == 1, "device name before data source")

        // A Bluetooth headset: Chromium's product name, macOS's owner name.
        let headsets = [
            MicrophoneCandidate(name: "Desk Mic"),
            MicrophoneCandidate(name: "Someone’s Earbuds Pro", bluetooth: true),
        ]
        expect(indexOfMicrophone(named: "Earbuds", among: headsets) == 1, "Bluetooth product name inside the device name")
        expect(indexOfMicrophone(named: "Earbuds (Bluetooth)", among: headsets) == 1, "tagged Bluetooth product name")
        expect(indexOfMicrophone(named: "Earbud", among: headsets) == nil, "part of a word is not a match")
        let twoHeadsets = headsets + [MicrophoneCandidate(name: "Earbuds Max", bluetooth: true)]
        expect(indexOfMicrophone(named: "Earbuds", among: twoHeadsets) == nil, "two candidate headsets are not guessed between")
        // Containment is for Bluetooth only; a wired prefix stays a miss.
        expect(indexOfMicrophone(named: "Desk", among: headsets) == nil, "not Bluetooth, no containment")

        expect(containsWords("A’s Earbuds Pro", "Earbuds"), "whole words")
        expect(!containsWords("EarbudsPro", "Earbuds"), "joined words")
        expect(!containsWords("Earbuds", ""), "empty phrase")

        expect(strippingTrailingParenthetical("(USB)") == "(USB)", "a bare tag is kept")
        expect(strippingTrailingParenthetical("Bran Mic") == "Bran Mic", "no tag")
        print("microphone match: ok")
    }
}
