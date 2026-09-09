import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// The hosted smoke requires PowerShell 7. Never inherit the inbox verifier's
// fail-open fallback when Windows PowerShell cannot initialize on that runner.
export async function verifyWindowsSmokeSignature(
  publishers: string[],
  filePath: string
): Promise<string | null> {
  if (publishers.length !== 1 || publishers[0] !== "PwrDrvr LLC") {
    throw new Error("Unexpected Windows smoke publisher configuration");
  }
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      !["PSMODULEPATH", "PWRSNAP_SIGNATURE_PATH"].includes(key.toUpperCase())
    )
  );
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$signature = Get-AuthenticodeSignature -LiteralPath $env:PWRSNAP_SIGNATURE_PATH
[ordered]@{
  status = [string]$signature.Status
  publisher = if ($null -eq $signature.SignerCertificate) { '' } else {
    $signature.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
  }
} | ConvertTo-Json -Compress
`;
  const { stdout, stderr } = await execFileAsync("pwsh.exe", [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
    Buffer.from(script, "utf16le").toString("base64")
  ], {
    env: { ...environment, PWRSNAP_SIGNATURE_PATH: filePath },
    windowsHide: true,
    timeout: 30_000,
    maxBuffer: 64 * 1024
  });
  if (stderr.trim()) throw new Error(`Smoke signature probe failed: ${stderr}`);
  const evidence = JSON.parse(stdout.replace(/^\uFEFF/, "").trim());
  if (evidence?.status !== "Valid" || evidence?.publisher !== publishers[0]) {
    throw new Error("Downloaded smoke installer must have a valid PwrDrvr LLC signature");
  }
  return null;
}
