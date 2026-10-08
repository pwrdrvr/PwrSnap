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
        expect(indexOfMicrophone(named: "Granola Interface", among: []) == nil, "no devices")

        // Exact beats stripped: "Oat Mic (USB)" must not resolve to "Oat Mic".
        let shadow = ["Oat Mic", "Oat Mic (USB)"]
        expect(indexOfMicrophone(named: "Oat Mic (USB)", among: shadow) == 1, "exact outranks a stripped match")

        expect(strippingTrailingParenthetical("(USB)") == "(USB)", "a bare tag is kept")
        expect(strippingTrailingParenthetical("Bran Mic") == "Bran Mic", "no tag")
        print("microphone match: ok")
    }
}
