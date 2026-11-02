// PwrSnap window-list helper (Windows).
//
// Windows counterpart to native/window-list/main.swift. Emits the live
// on-screen window list as a single JSON object to stdout, in the EXACT
// same envelope shape the macOS helper produces so the shared TypeScript
// wrapper (src/main/capture/window-list.ts → parseHelperOutput) parses
// either platform's output with one code path:
//
//   {
//     "windows": [
//       { "windowId": 123, "pid": 456,
//         "bundleId": "C:\\Program Files\\Slack\\slack.exe",
//         "appName": "slack", "title": "general - PwrDrvr",
//         "bounds": { "x": 100, "y": 100, "width": 800, "height": 600 },
//         "layer": 0, "alpha": 1.0, "isFrontmostInApp": true },
//       ...
//     ],
//     "frontmostPid": 456,
//     "frontmostBundleId": "C:\\Program Files\\Slack\\slack.exe"
//   }
//
// Field-by-field parity with the macOS helper:
//   - windowId      → the HWND value (numeric, stable for the window's
//                     lifetime). The macOS helper uses CGWindowNumber;
//                     both are opaque per-window ids the caller only
//                     compares for equality and ships back for snap.
//   - pid           → owning process id (GetWindowThreadProcessId).
//   - bundleId      → the owning process's full exe path. macOS has a
//                     real reverse-DNS bundle id; Windows has no such
//                     concept, so we use the exe path — it's the stable
//                     per-app identifier the source-app metadata + the
//                     selector's "is this one of ours" check rely on.
//                     Null when the path can't be resolved (system /
//                     protected processes).
//   - appName       → exe file name without the `.exe` extension
//                     ("slack", "chrome", "Code"). Analogous to the
//                     macOS owner name.
//   - title         → GetWindowTextW. Null when empty.
//   - bounds        → the window's extended frame bounds in physical
//                     virtual-screen pixels (top-left origin). The shared
//                     TypeScript boundary converts these to Electron DIPs
//                     with `screen.screenToDipRect` before display filtering,
//                     hit testing, or selector rendering. We prefer the DWM
//                     extended-frame rect (DWMWA_EXTENDED_FRAME_BOUNDS)
//                     over GetWindowRect because GetWindowRect on
//                     DWM-composited windows includes the invisible
//                     resize-border padding (typically ~7px each side),
//                     which would make snap highlights overshoot the
//                     visible window edges. Falls back to GetWindowRect
//                     if the DWM query fails.
//   - layer         → always 0. The macOS helper drops layer != 0
//                     (menu bar / dock / status items) and keeps layer
//                     0 (normal app windows). Windows has no equivalent
//                     numeric layer; we apply equivalent filtering via
//                     style/cloak checks below and report 0 for every
//                     surviving window so the shared filter that keeps
//                     `layer === 0` stays satisfied.
//   - alpha         → 1.0 for opaque windows; the per-window layered
//                     alpha (0..1) when the window is WS_EX_LAYERED with
//                     a global alpha set. Fully-transparent (alpha 0)
//                     windows are dropped, matching the macOS helper.
//   - isFrontmostInApp → true for the first window per pid in z-order
//                     (front-to-back), matching the macOS helper's
//                     seenFrontmostByPid logic.
//
// Filtering — match the macOS helper's "real, user-visible top-level
// windows" semantics:
//   - !IsWindowVisible           → drop hidden windows.
//   - WS_EX_TOOLWINDOW           → drop tool windows (floating palettes,
//                                  toolbars) — they never appear in the
//                                  taskbar / Alt-Tab and aren't snap
//                                  targets, the closest analog to the
//                                  macOS layer != 0 chrome drop.
//   - shell furniture            → drop the desktop host (Progman /
//                                  WorkerW) and the taskbars
//                                  (Shell_TrayWnd / Shell_SecondaryTrayWnd)
//                                  by window class — they're visible,
//                                  titled, non-tool top-levels that would
//                                  otherwise be snap targets (the desktop
//                                  is full-screen). See IsShellFurniture.
//   - DWMWA_CLOAKED              → drop cloaked windows (UWP suspended
//                                  apps, windows on another virtual
//                                  desktop, ghost windows). Their
//                                  GetWindowRect lies; capturing them
//                                  would grab stale/empty pixels.
//   - zero / sub-4px dimensions  → drop, matching the macOS < 4px gate.
//   - empty-title + no-owner     → drop unowned, untitled top-levels
//                                  (these are the invisible message-only
//                                  / helper windows every process keeps
//                                  around). A titled top-level survives
//                                  even with no taskbar presence.
//
// Additional command:
//   --extract-app-icon <exe-path> <output.png> <size>
//     Resolves the executable's shell icon through IShellItemImageFactory
//     and encodes it as PNG with Windows Imaging Component. This is the
//     Windows counterpart to the Swift helper's NSWorkspace-backed command.
//
//   --write-file-clipboard <absolute-file-path>
//     Writes one existing file to the Windows clipboard as the predefined
//     numeric CF_HDROP format (DROPFILES + UTF-16 path list) plus the
//     registered Preferred DropEffect=COPY format. Reads CF_HDROP back with
//     DragQueryFileW before returning success, so the Electron caller never
//     reports a copy that produced an empty/custom-format-only clipboard.
//
//   --read-file-clipboard
//     Reads the predefined numeric CF_HDROP format and returns every
//     fully-qualified UTF-16 file path as a JSON array. This is the Windows
//     Explorer counterpart to the macOS public.file-url read path; callers
//     decide whether the list cardinality/type is valid for their operation.
//
// Build: cl.exe /O2 /EHsc /std:c++17 main.cpp /Fe:window-list.exe
//        user32.lib gdi32.lib dwmapi.lib shell32.lib ole32.lib
//        windowscodecs.lib (compiled by
//        apps/desktop/scripts/build-native.mjs's win32 branch).
//        Shipped under Resources/PwrSnapWindowList.exe via the
//        extraResources entry in electron-builder.yml.

#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif

// Target Windows 8+ so DWMWA_CLOAKED (introduced in 6.2) is available.
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0602
#endif

#include <windows.h>
#include <dwmapi.h>
#include <psapi.h>
#include <shellapi.h>
#include <shlobj.h>  // DROPFILES (declared by shlobj_core.h)
#include <shobjidl.h>
#include <wincodec.h>

#include <cstdint>
#include <cstring>
#include <cstdio>
#include <cwchar>
#include <string>
#include <vector>

#include <io.h>
#include <fcntl.h>

namespace {

// CF_HDROP is a predefined clipboard format, not a registered string format.
// Pin the Windows SDK contract explicitly so this helper can never drift into
// writing a custom format that only happens to be named "CF_HDROP".
static_assert(CF_HDROP == 15, "Win32 CF_HDROP format id changed");

struct WindowInfo {
  long long windowId;
  unsigned long pid;
  std::wstring exePath;  // "" when unresolved → emitted as null
  std::wstring appName;  // exe basename without extension
  std::wstring title;    // "" when empty → emitted as null
  long x;
  long y;
  long width;
  long height;
  double alpha;
  bool isFrontmostInApp;
};

template <typename T>
void SafeRelease(T **value) {
  if (*value != nullptr) {
    (*value)->Release();
    *value = nullptr;
  }
}

// Convert a UTF-16 (wide) string to UTF-8 for JSON output.
std::string ToUtf8(const std::wstring &w) {
  if (w.empty()) {
    return std::string();
  }
  const int needed = WideCharToMultiByte(CP_UTF8, 0, w.c_str(),
                                         static_cast<int>(w.size()), nullptr, 0,
                                         nullptr, nullptr);
  if (needed <= 0) {
    return std::string();
  }
  std::string out(static_cast<size_t>(needed), '\0');
  WideCharToMultiByte(CP_UTF8, 0, w.c_str(), static_cast<int>(w.size()),
                      &out[0], needed, nullptr, nullptr);
  return out;
}

// Encode a shell-provided HBITMAP as a transparent PNG using WIC. Keeping
// this in the existing helper means Electron's sandboxed renderer never sees
// or opens the executable path directly.
HRESULT SaveBitmapAsPng(HBITMAP bitmap, const std::wstring &outputPath) {
  IWICImagingFactory *factory = nullptr;
  IWICBitmap *wicBitmap = nullptr;
  IWICStream *stream = nullptr;
  IWICBitmapEncoder *encoder = nullptr;
  IWICBitmapFrameEncode *frame = nullptr;

  HRESULT hr = CoCreateInstance(CLSID_WICImagingFactory, nullptr,
                                CLSCTX_INPROC_SERVER,
                                IID_PPV_ARGS(&factory));
  if (SUCCEEDED(hr)) {
    hr = factory->CreateBitmapFromHBITMAP(
        bitmap, nullptr, WICBitmapUsePremultipliedAlpha, &wicBitmap);
  }
  if (SUCCEEDED(hr)) {
    hr = factory->CreateStream(&stream);
  }
  if (SUCCEEDED(hr)) {
    hr = stream->InitializeFromFilename(outputPath.c_str(), GENERIC_WRITE);
  }
  if (SUCCEEDED(hr)) {
    hr = factory->CreateEncoder(GUID_ContainerFormatPng, nullptr, &encoder);
  }
  if (SUCCEEDED(hr)) {
    hr = encoder->Initialize(stream, WICBitmapEncoderNoCache);
  }
  if (SUCCEEDED(hr)) {
    hr = encoder->CreateNewFrame(&frame, nullptr);
  }
  if (SUCCEEDED(hr)) {
    hr = frame->Initialize(nullptr);
  }
  if (SUCCEEDED(hr)) {
    UINT width = 0;
    UINT height = 0;
    hr = wicBitmap->GetSize(&width, &height);
    if (SUCCEEDED(hr)) {
      hr = frame->SetSize(width, height);
    }
  }
  if (SUCCEEDED(hr)) {
    WICPixelFormatGUID pixelFormat = GUID_WICPixelFormat32bppBGRA;
    hr = frame->SetPixelFormat(&pixelFormat);
  }
  if (SUCCEEDED(hr)) {
    hr = frame->WriteSource(wicBitmap, nullptr);
  }
  if (SUCCEEDED(hr)) {
    hr = frame->Commit();
  }
  if (SUCCEEDED(hr)) {
    hr = encoder->Commit();
  }

  SafeRelease(&frame);
  SafeRelease(&encoder);
  SafeRelease(&stream);
  SafeRelease(&wicBitmap);
  SafeRelease(&factory);
  return hr;
}

int ExtractAppIcon(const std::wstring &exePath,
                   const std::wstring &outputPath, int size) {
  if (exePath.empty() || outputPath.empty() || size < 16 || size > 512) {
    std::fputs("invalid app-icon arguments\n", stderr);
    return 2;
  }
  const DWORD attrs = GetFileAttributesW(exePath.c_str());
  if (attrs == INVALID_FILE_ATTRIBUTES ||
      (attrs & FILE_ATTRIBUTE_DIRECTORY) != 0) {
    std::fputs("source executable is unavailable\n", stderr);
    return 3;
  }

  const HRESULT initHr = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
  const bool shouldUninitialize = SUCCEEDED(initHr);
  if (FAILED(initHr) && initHr != RPC_E_CHANGED_MODE) {
    std::fputs("COM initialization failed\n", stderr);
    return 4;
  }

  IShellItemImageFactory *imageFactory = nullptr;
  HRESULT hr = SHCreateItemFromParsingName(
      exePath.c_str(), nullptr, IID_PPV_ARGS(&imageFactory));
  HBITMAP bitmap = nullptr;
  if (SUCCEEDED(hr)) {
    const SIZE requested = {size, size};
    const SIIGBF flags = static_cast<SIIGBF>(SIIGBF_ICONONLY |
                                             SIIGBF_BIGGERSIZEOK);
    hr = imageFactory->GetImage(requested, flags, &bitmap);
  }
  if (SUCCEEDED(hr) && bitmap == nullptr) {
    hr = E_FAIL;
  }
  if (SUCCEEDED(hr) && bitmap != nullptr) {
    hr = SaveBitmapAsPng(bitmap, outputPath);
  }

  if (bitmap != nullptr) {
    DeleteObject(bitmap);
  }
  SafeRelease(&imageFactory);
  if (shouldUninitialize) {
    CoUninitialize();
  }

  if (FAILED(hr)) {
    std::fprintf(stderr, "app-icon extraction failed (0x%08lx)\n",
                 static_cast<unsigned long>(hr));
    return 4;
  }

  const std::string sourceUtf8 = ToUtf8(exePath);
  std::fwrite(sourceUtf8.data(), 1, sourceUtf8.size(), stdout);
  return 0;
}

// GetFullPathNameW preserves drive-letter and UNC semantics while ensuring the
// CF_HDROP path is fully qualified as required by the Shell clipboard
// contract. The returned size includes the trailing NUL when the buffer is too
// small, so retry until the path fits rather than imposing MAX_PATH.
std::wstring FullyQualifiedPath(const std::wstring &input) {
  DWORD capacity = GetFullPathNameW(input.c_str(), 0, nullptr, nullptr);
  if (capacity == 0) {
    return std::wstring();
  }
  std::vector<wchar_t> buffer(static_cast<size_t>(capacity));
  for (;;) {
    const DWORD copied = GetFullPathNameW(
        input.c_str(), static_cast<DWORD>(buffer.size()), buffer.data(), nullptr);
    if (copied == 0) {
      return std::wstring();
    }
    if (copied < buffer.size()) {
      return std::wstring(buffer.data(), static_cast<size_t>(copied));
    }
    buffer.resize(static_cast<size_t>(copied) + 1);
  }
}

int WriteFileClipboard(const std::wstring &inputPath) {
  if (inputPath.empty()) {
    std::fputs("clipboard file path is empty\n", stderr);
    return 2;
  }

  const std::wstring filePath = FullyQualifiedPath(inputPath);
  if (filePath.empty()) {
    std::fputs("clipboard file path could not be made absolute\n", stderr);
    return 2;
  }
  const DWORD attrs = GetFileAttributesW(filePath.c_str());
  if (attrs == INVALID_FILE_ATTRIBUTES ||
      (attrs & FILE_ATTRIBUTE_DIRECTORY) != 0) {
    std::fputs("clipboard file is unavailable or is not a regular file\n",
               stderr);
    return 3;
  }

  // DROPFILES is followed immediately by one NUL-terminated path and an
  // additional NUL terminator for the end of the list. GMEM_ZEROINIT supplies
  // both terminators once the path bytes are copied.
  const SIZE_T dropBytes =
      sizeof(DROPFILES) + (filePath.size() + 2) * sizeof(wchar_t);
  HGLOBAL dropMemory = GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, dropBytes);
  if (dropMemory == nullptr) {
    std::fputs("CF_HDROP allocation failed\n", stderr);
    return 4;
  }
  void *dropRaw = GlobalLock(dropMemory);
  if (dropRaw == nullptr) {
    GlobalFree(dropMemory);
    std::fputs("CF_HDROP lock failed\n", stderr);
    return 4;
  }
  DROPFILES *drop = static_cast<DROPFILES *>(dropRaw);
  drop->pFiles = sizeof(DROPFILES);
  drop->pt.x = 0;
  drop->pt.y = 0;
  drop->fNC = FALSE;
  drop->fWide = TRUE;
  wchar_t *pathList = reinterpret_cast<wchar_t *>(
      static_cast<unsigned char *>(dropRaw) + sizeof(DROPFILES));
  std::memcpy(pathList, filePath.c_str(),
              (filePath.size() + 1) * sizeof(wchar_t));
  GlobalUnlock(dropMemory);

  const UINT preferredDropEffectFormat =
      RegisterClipboardFormatW(L"Preferred DropEffect");
  if (preferredDropEffectFormat == 0) {
    GlobalFree(dropMemory);
    std::fputs("Preferred DropEffect registration failed\n", stderr);
    return 4;
  }
  HGLOBAL effectMemory =
      GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, sizeof(DWORD));
  if (effectMemory == nullptr) {
    GlobalFree(dropMemory);
    std::fputs("Preferred DropEffect allocation failed\n", stderr);
    return 4;
  }
  DWORD *effect = static_cast<DWORD *>(GlobalLock(effectMemory));
  if (effect == nullptr) {
    GlobalFree(effectMemory);
    GlobalFree(dropMemory);
    std::fputs("Preferred DropEffect lock failed\n", stderr);
    return 4;
  }
  *effect = DROPEFFECT_COPY;
  GlobalUnlock(effectMemory);

  // OpenClipboard(NULL) is unsafe here: after EmptyClipboard, Windows assigns
  // a NULL owner and SetClipboardData can fail. A real hidden owner HWND keeps
  // the ownership contract well-defined without surfacing any UI.
  HWND owner = CreateWindowExW(0, L"STATIC", L"PwrSnap Clipboard Owner",
                               WS_OVERLAPPED, 0, 0, 0, 0, nullptr, nullptr,
                               GetModuleHandleW(nullptr), nullptr);
  if (owner == nullptr) {
    GlobalFree(effectMemory);
    GlobalFree(dropMemory);
    std::fputs("clipboard owner window creation failed\n", stderr);
    return 5;
  }

  bool opened = false;
  for (int attempt = 0; attempt < 20; ++attempt) {
    if (OpenClipboard(owner) != 0) {
      opened = true;
      break;
    }
    Sleep(25);
  }
  if (!opened) {
    DestroyWindow(owner);
    GlobalFree(effectMemory);
    GlobalFree(dropMemory);
    std::fputs("clipboard is busy\n", stderr);
    return 5;
  }

  bool dropTransferred = false;
  bool effectTransferred = false;
  auto failAfterOpen = [&](const char *message) -> int {
    // Once any handle has transferred, EmptyClipboard lets the system free it
    // and prevents a partial CF_HDROP-only clipboard from masquerading as a
    // complete copy operation.
    if (dropTransferred || effectTransferred) {
      EmptyClipboard();
    }
    CloseClipboard();
    DestroyWindow(owner);
    if (!dropTransferred) {
      GlobalFree(dropMemory);
    }
    if (!effectTransferred) {
      GlobalFree(effectMemory);
    }
    std::fputs(message, stderr);
    std::fputc('\n', stderr);
    return 6;
  };

  if (EmptyClipboard() == 0) {
    return failAfterOpen("clipboard clear failed");
  }
  if (SetClipboardData(CF_HDROP, dropMemory) == nullptr) {
    return failAfterOpen("CF_HDROP write failed");
  }
  dropTransferred = true;
  if (SetClipboardData(preferredDropEffectFormat, effectMemory) == nullptr) {
    return failAfterOpen("Preferred DropEffect write failed");
  }
  effectTransferred = true;

  // Verify the exact native formats while the clipboard is still open. This
  // is deliberately stronger than an exit-code-only contract: a named custom
  // format called "CF_HDROP" would fail IsClipboardFormatAvailable(15), and
  // an invalid/empty DROPFILES buffer would fail DragQueryFileW.
  if (IsClipboardFormatAvailable(CF_HDROP) == 0 ||
      IsClipboardFormatAvailable(preferredDropEffectFormat) == 0) {
    return failAfterOpen("clipboard formats were not retained");
  }
  HDROP writtenDrop = static_cast<HDROP>(GetClipboardData(CF_HDROP));
  if (writtenDrop == nullptr ||
      DragQueryFileW(writtenDrop, 0xFFFFFFFF, nullptr, 0) != 1) {
    return failAfterOpen("CF_HDROP readback contained no single file");
  }
  const UINT pathLength = DragQueryFileW(writtenDrop, 0, nullptr, 0);
  std::vector<wchar_t> readback(static_cast<size_t>(pathLength) + 1, L'\0');
  if (pathLength == 0 ||
      DragQueryFileW(writtenDrop, 0, readback.data(),
                     static_cast<UINT>(readback.size())) != pathLength ||
      std::wstring(readback.data(), static_cast<size_t>(pathLength)) !=
          filePath) {
    return failAfterOpen("CF_HDROP readback path mismatch");
  }
  HGLOBAL writtenEffect =
      static_cast<HGLOBAL>(GetClipboardData(preferredDropEffectFormat));
  const DWORD *readbackEffect = writtenEffect == nullptr
                                    ? nullptr
                                    : static_cast<const DWORD *>(
                                          GlobalLock(writtenEffect));
  const bool effectMatches =
      readbackEffect != nullptr && *readbackEffect == DROPEFFECT_COPY;
  if (readbackEffect != nullptr) {
    GlobalUnlock(writtenEffect);
  }
  if (!effectMatches) {
    return failAfterOpen("Preferred DropEffect readback mismatch");
  }

  if (CloseClipboard() == 0) {
    DestroyWindow(owner);
    std::fputs("clipboard close failed\n", stderr);
    return 6;
  }
  DestroyWindow(owner);
  std::fputs(
      "{\"ok\":true,\"format\":\"CF_HDROP\",\"files\":1,"
      "\"dropEffect\":\"copy\"}",
      stdout);
  std::fflush(stdout);
  return 0;
}

// Escape a UTF-8 string for embedding inside a JSON string literal.
// Handles the JSON-mandatory escapes (quote, backslash, control chars).
// Backslashes are common on Windows (exe paths) — getting this right is
// load-bearing for the TS-side JSON.parse.
std::string JsonEscape(const std::string &s) {
  std::string out;
  out.reserve(s.size() + 8);
  for (unsigned char c : s) {
    switch (c) {
      case '"':
        out += "\\\"";
        break;
      case '\\':
        out += "\\\\";
        break;
      case '\b':
        out += "\\b";
        break;
      case '\f':
        out += "\\f";
        break;
      case '\n':
        out += "\\n";
        break;
      case '\r':
        out += "\\r";
        break;
      case '\t':
        out += "\\t";
        break;
      default:
        if (c < 0x20) {
          char buf[8];
          std::snprintf(buf, sizeof(buf), "\\u%04x", c);
          out += buf;
        } else {
          out += static_cast<char>(c);
        }
        break;
    }
  }
  return out;
}

bool IsFullyQualifiedWindowsPath(const std::wstring &path) {
  // Drive-rooted path: C:\foo (a drive-relative C:foo is intentionally false).
  if (path.size() >= 3 &&
      ((path[0] >= L'A' && path[0] <= L'Z') ||
       (path[0] >= L'a' && path[0] <= L'z')) &&
      path[1] == L':' && (path[2] == L'\\' || path[2] == L'/')) {
    return true;
  }
  // UNC and extended-length paths both begin with two separators:
  // \\server\share\file.png, \\?\C:\..., or \\?\UNC\server\share\...
  return path.size() >= 2 &&
         (path[0] == L'\\' || path[0] == L'/') &&
         (path[1] == L'\\' || path[1] == L'/');
}

int ReadFileClipboard() {
  bool opened = false;
  for (int attempt = 0; attempt < 20; ++attempt) {
    // A NULL owner is valid for read-only access. The non-NULL owner rule in
    // WriteFileClipboard is specifically required before EmptyClipboard +
    // SetClipboardData.
    if (OpenClipboard(nullptr) != 0) {
      opened = true;
      break;
    }
    Sleep(25);
  }
  if (!opened) {
    std::fputs("clipboard is busy\n", stderr);
    return 5;
  }

  // No native file list is a normal outcome: return an empty list so the
  // TypeScript caller can continue to macOS URL/text or bitmap fallbacks.
  if (IsClipboardFormatAvailable(CF_HDROP) == 0) {
    CloseClipboard();
    std::fputs("{\"ok\":true,\"format\":\"CF_HDROP\",\"files\":[]}",
               stdout);
    std::fflush(stdout);
    return 0;
  }

  HDROP drop = static_cast<HDROP>(GetClipboardData(CF_HDROP));
  if (drop == nullptr) {
    CloseClipboard();
    std::fputs("CF_HDROP read failed\n", stderr);
    return 6;
  }
  const UINT count = DragQueryFileW(drop, 0xFFFFFFFF, nullptr, 0);
  // An advertised CF_HDROP with no paths is malformed, not the same thing as
  // an absent format. Keep files:[] reserved for the absence branch above so
  // the TypeScript caller can distinguish "nothing to ingest" from corrupt
  // native clipboard data.
  if (count == 0) {
    CloseClipboard();
    std::fputs("CF_HDROP contains no files\n", stderr);
    return 6;
  }
  // Bound an untrusted clipboard allocation before walking it. The capture
  // paste contract accepts exactly one path, so a larger list is never useful;
  // still return ordinary multi-file lists so the caller can give a precise
  // cardinality error.
  if (count > 256) {
    CloseClipboard();
    std::fputs("CF_HDROP contains too many files\n", stderr);
    return 6;
  }

  std::vector<std::wstring> files;
  files.reserve(static_cast<size_t>(count));
  for (UINT index = 0; index < count; ++index) {
    const UINT length = DragQueryFileW(drop, index, nullptr, 0);
    if (length == 0 || length > 32767) {
      CloseClipboard();
      std::fputs("CF_HDROP contains an invalid path\n", stderr);
      return 6;
    }
    std::vector<wchar_t> path(static_cast<size_t>(length) + 1, L'\0');
    if (DragQueryFileW(drop, index, path.data(),
                       static_cast<UINT>(path.size())) != length) {
      CloseClipboard();
      std::fputs("CF_HDROP path readback failed\n", stderr);
      return 6;
    }
    std::wstring value(path.data(), static_cast<size_t>(length));
    if (!IsFullyQualifiedWindowsPath(value)) {
      CloseClipboard();
      std::fputs("CF_HDROP path is not fully qualified\n", stderr);
      return 6;
    }
    files.push_back(value);
  }
  if (CloseClipboard() == 0) {
    std::fputs("clipboard close failed\n", stderr);
    return 6;
  }

  std::string json = "{\"ok\":true,\"format\":\"CF_HDROP\",\"files\":[";
  for (size_t index = 0; index < files.size(); ++index) {
    if (index != 0) {
      json += ',';
    }
    json += '"';
    json += JsonEscape(ToUtf8(files[index]));
    json += '"';
  }
  json += "]}";
  std::fwrite(json.data(), 1, json.size(), stdout);
  std::fflush(stdout);
  return 0;
}

// Full path of the executable backing `pid`, e.g.
// "C:\\Program Files\\Slack\\slack.exe". Empty string when the process
// can't be opened (system / protected processes) or the query fails.
std::wstring ExePathForPid(unsigned long pid) {
  if (pid == 0) {
    return std::wstring();
  }
  // PROCESS_QUERY_LIMITED_INFORMATION (Vista+) is enough for
  // QueryFullProcessImageNameW and is grantable for more processes than
  // the heavier PROCESS_QUERY_INFORMATION.
  HANDLE proc =
      OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (proc == nullptr) {
    return std::wstring();
  }
  wchar_t buf[MAX_PATH * 2];
  DWORD size = static_cast<DWORD>(sizeof(buf) / sizeof(buf[0]));
  std::wstring result;
  if (QueryFullProcessImageNameW(proc, 0, buf, &size) && size > 0) {
    result.assign(buf, size);
  }
  CloseHandle(proc);
  return result;
}

// Derive the app name from the exe path: file name minus the trailing
// extension. "C:\\...\\slack.exe" → "slack". Empty when no usable path.
std::wstring AppNameFromExePath(const std::wstring &exePath) {
  if (exePath.empty()) {
    return std::wstring();
  }
  size_t slash = exePath.find_last_of(L"\\/");
  std::wstring base =
      (slash == std::wstring::npos) ? exePath : exePath.substr(slash + 1);
  size_t dot = base.find_last_of(L'.');
  if (dot != std::wstring::npos && dot > 0) {
    base = base.substr(0, dot);
  }
  return base;
}

// True when DWM reports the window as cloaked (suspended UWP app, window
// on another virtual desktop, ghost window). These windows report stale
// or empty bounds and must not appear as snap targets.
bool IsCloaked(HWND hwnd) {
  DWORD cloaked = 0;
  HRESULT hr = DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, &cloaked,
                                     sizeof(cloaked));
  return SUCCEEDED(hr) && cloaked != 0;
}

// True for the Windows shell's own "furniture" windows — the desktop
// host and the taskbar(s). These are visible, titled, non-tool,
// non-cloaked top-levels that would otherwise sail through the filter
// and show up as snap targets (the desktop in particular is full-screen,
// so it becomes a giant bogus target sitting under every real window).
// They're the Windows analog of the macOS dock / menu bar / status items
// the Swift helper drops via `layer != 0`. Matched by window class:
//   - Progman                → the desktop host ("Program Manager"),
//                              full-screen.
//   - WorkerW                → the wallpaper/desktop worker window that
//                              hosts icons behind Progman.
//   - Shell_TrayWnd          → the primary taskbar.
//   - Shell_SecondaryTrayWnd → taskbars on secondary monitors.
// We deliberately do NOT drop `Windows.UI.Core.CoreWindow` here: an
// uncloaked CoreWindow is usually active system UI (Start / Search) but
// can also back a real foreground UWP app, and the cloak check above
// already hides the inactive ones — so blanket-dropping it risks losing
// a legitimate snap target. Revisit if shell UI proves noisy in practice.
bool IsShellFurniture(HWND hwnd) {
  wchar_t cls[64];
  int n = GetClassNameW(hwnd, cls, static_cast<int>(sizeof(cls) / sizeof(cls[0])));
  if (n <= 0) {
    return false;
  }
  const std::wstring name(cls, static_cast<size_t>(n));
  return name == L"Progman" || name == L"WorkerW" ||
         name == L"Shell_TrayWnd" || name == L"Shell_SecondaryTrayWnd";
}

// Visible bounds of the window in virtual-screen coords. Prefer the DWM
// extended-frame rect (excludes the invisible resize-border padding that
// GetWindowRect includes for DWM-composited windows); fall back to
// GetWindowRect when the DWM query is unavailable.
bool WindowBounds(HWND hwnd, RECT *out) {
  RECT frame = {0, 0, 0, 0};
  HRESULT hr = DwmGetWindowAttribute(hwnd, DWMWA_EXTENDED_FRAME_BOUNDS,
                                     &frame, sizeof(frame));
  if (SUCCEEDED(hr) && frame.right > frame.left && frame.bottom > frame.top) {
    *out = frame;
    return true;
  }
  return GetWindowRect(hwnd, out) != 0;
}

// Per-window layered alpha in [0, 1]. 1.0 for ordinary opaque windows.
// Mirrors the macOS helper's CGWindowAlpha: a global per-window alpha
// (not per-pixel). Fully transparent (0) windows are dropped upstream.
double WindowAlpha(HWND hwnd) {
  const LONG_PTR exStyle = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
  if ((exStyle & WS_EX_LAYERED) == 0) {
    return 1.0;
  }
  BYTE bAlpha = 255;
  DWORD flags = 0;
  if (GetLayeredWindowAttributes(hwnd, nullptr, &bAlpha, &flags) &&
      (flags & LWA_ALPHA) != 0) {
    return static_cast<double>(bAlpha) / 255.0;
  }
  // Per-pixel layered windows (LWA_ALPHA not set) report no global
  // alpha — treat as opaque; their content carries its own
  // transparency.
  return 1.0;
}

std::vector<WindowInfo> *g_windows = nullptr;

BOOL CALLBACK EnumProc(HWND hwnd, LPARAM /*lparam*/) {
  // Skip invisible windows — matches the macOS alpha==0 / off-screen drop.
  if (!IsWindowVisible(hwnd)) {
    return TRUE;
  }

  const LONG_PTR exStyle = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
  // Tool windows (WS_EX_TOOLWINDOW): floating palettes / toolbars that
  // never show in the taskbar or Alt-Tab. Closest analog to the macOS
  // layer != 0 chrome drop. Not snap targets.
  if ((exStyle & WS_EX_TOOLWINDOW) != 0) {
    return TRUE;
  }

  // Shell furniture (desktop host + taskbars) — never snap targets, and
  // the full-screen desktop would otherwise be a giant bogus target.
  if (IsShellFurniture(hwnd)) {
    return TRUE;
  }

  // Cloaked windows report stale bounds — drop (see IsCloaked).
  if (IsCloaked(hwnd)) {
    return TRUE;
  }

  RECT rect;
  if (!WindowBounds(hwnd, &rect)) {
    return TRUE;
  }
  const long width = rect.right - rect.left;
  const long height = rect.bottom - rect.top;
  // Drop sub-4px windows — mirrors the macOS < 4 gate (tracking
  // shadows / 1×1 message strips).
  if (width < 4 || height < 4) {
    return TRUE;
  }

  const double alpha = WindowAlpha(hwnd);
  if (alpha == 0.0) {
    return TRUE;
  }

  // Title — empty becomes null in the JSON.
  int titleLen = GetWindowTextLengthW(hwnd);
  std::wstring title;
  if (titleLen > 0) {
    title.resize(static_cast<size_t>(titleLen) + 1);
    int copied = GetWindowTextW(hwnd, &title[0],
                                static_cast<int>(title.size()));
    title.resize(static_cast<size_t>(copied < 0 ? 0 : copied));
  }

  // Drop untitled top-levels that also have no owner: these are the
  // invisible message-only / helper windows every process keeps around.
  // A titled top-level survives even when it has no taskbar presence.
  const bool hasOwner = GetWindow(hwnd, GW_OWNER) != nullptr;
  if (title.empty() && !hasOwner) {
    return TRUE;
  }

  DWORD pid = 0;
  GetWindowThreadProcessId(hwnd, &pid);
  std::wstring exePath = ExePathForPid(pid);
  std::wstring appName = AppNameFromExePath(exePath);

  WindowInfo info;
  // HWND is a pointer-sized handle. Cast through uintptr_t so we don't
  // sign-extend on 64-bit, then store as a signed 64-bit id (fits a JS
  // safe integer — HWND values are small handle-table indices in
  // practice, well under 2^53).
  info.windowId =
      static_cast<long long>(reinterpret_cast<uintptr_t>(hwnd));
  info.pid = pid;
  info.exePath = exePath;
  info.appName = appName;
  info.title = title;
  info.x = rect.left;
  info.y = rect.top;
  info.width = width;
  info.height = height;
  info.alpha = alpha;
  info.isFrontmostInApp = false;  // assigned after enumeration

  g_windows->push_back(info);
  return TRUE;
}

// Append a JSON string value (escaped + quoted) or the literal null when
// the source is empty.
void AppendJsonStringOrNull(std::string *out, const std::wstring &value) {
  if (value.empty()) {
    *out += "null";
  } else {
    *out += '"';
    *out += JsonEscape(ToUtf8(value));
    *out += '"';
  }
}

}  // namespace

int wmain(int argc, wchar_t *argv[]) {
  if (argc >= 2 && std::wstring(argv[1]) == L"--read-file-clipboard") {
    if (argc != 2) {
      std::fputs("usage: --read-file-clipboard\n", stderr);
      return 2;
    }
    return ReadFileClipboard();
  }

  if (argc >= 2 && std::wstring(argv[1]) == L"--write-file-clipboard") {
    if (argc != 3) {
      std::fputs("usage: --write-file-clipboard <absolute-file-path>\n",
                 stderr);
      return 2;
    }
    return WriteFileClipboard(argv[2]);
  }

  if (argc >= 2 && std::wstring(argv[1]) == L"--extract-app-icon") {
    if (argc != 5) {
      std::fputs(
          "usage: --extract-app-icon <exe-path> <output.png> <size>\n",
          stderr);
      return 2;
    }
    wchar_t *end = nullptr;
    const long parsedSize = std::wcstol(argv[4], &end, 10);
    if (end == argv[4] || *end != L'\0' || parsedSize < 16 ||
        parsedSize > 512) {
      std::fputs("invalid app-icon size\n", stderr);
      return 2;
    }
    return ExtractAppIcon(argv[2], argv[3], static_cast<int>(parsedSize));
  }

  // Per-monitor DPI awareness so GetWindowRect / DWM bounds come back in
  // true physical pixels of the virtual-screen coordinate space rather
  // than being virtualized by the OS for a DPI-unaware process. The
  // TypeScript boundary deliberately converts these physical rectangles to
  // Electron DIPs with screen.screenToDipRect. SetProcessDpiAwarenessContext is
  // Win10 1703+; fall back gracefully (older paths still produce usable
  // coords, just potentially DPI-scaled on mixed-DPI setups).
  HMODULE user32 = GetModuleHandleW(L"user32.dll");
  if (user32 != nullptr) {
    typedef BOOL(WINAPI * SetCtxFn)(DPI_AWARENESS_CONTEXT);
    SetCtxFn setCtx = reinterpret_cast<SetCtxFn>(
        GetProcAddress(user32, "SetProcessDpiAwarenessContext"));
    if (setCtx != nullptr) {
      setCtx(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    }
  }

  std::vector<WindowInfo> windows;
  g_windows = &windows;
  // EnumWindows visits top-level windows in Z-order, topmost first —
  // the same front-to-back order CGWindowListCopyWindowInfo returns, so
  // the shared findWindowAt() linear scan picks the visually-topmost
  // window at a point on both platforms.
  EnumWindows(EnumProc, 0);
  g_windows = nullptr;

  // Mark the first window per pid (in z-order) as frontmost-in-app —
  // mirrors the macOS helper's seenFrontmostByPid pass.
  std::vector<unsigned long> seenPids;
  for (auto &w : windows) {
    bool seen = false;
    for (unsigned long p : seenPids) {
      if (p == w.pid) {
        seen = true;
        break;
      }
    }
    if (!seen) {
      w.isFrontmostInApp = true;
      seenPids.push_back(w.pid);
    }
  }

  // Frontmost app = owner of GetForegroundWindow(). The TS side
  // cross-checks windows[0].pid against this to detect z-order /
  // frontmost disagreement (same diagnostic as macOS).
  long long frontmostPid = -1;
  std::wstring frontmostExe;
  HWND fg = GetForegroundWindow();
  if (fg != nullptr) {
    DWORD fgPid = 0;
    GetWindowThreadProcessId(fg, &fgPid);
    if (fgPid != 0) {
      frontmostPid = static_cast<long long>(fgPid);
      frontmostExe = ExePathForPid(fgPid);
    }
  }

  // Build the JSON envelope. Single object, no trailing newline —
  // identical shape to the macOS helper's WindowListSnapshot.
  std::string json;
  json.reserve(windows.size() * 160 + 64);
  json += "{\"windows\":[";
  for (size_t i = 0; i < windows.size(); ++i) {
    const WindowInfo &w = windows[i];
    if (i != 0) {
      json += ',';
    }
    json += "{\"windowId\":";
    json += std::to_string(w.windowId);
    json += ",\"pid\":";
    json += std::to_string(static_cast<long long>(w.pid));
    json += ",\"bundleId\":";
    AppendJsonStringOrNull(&json, w.exePath);
    json += ",\"appName\":";
    AppendJsonStringOrNull(&json, w.appName);
    json += ",\"title\":";
    AppendJsonStringOrNull(&json, w.title);
    json += ",\"bounds\":{\"x\":";
    json += std::to_string(w.x);
    json += ",\"y\":";
    json += std::to_string(w.y);
    json += ",\"width\":";
    json += std::to_string(w.width);
    json += ",\"height\":";
    json += std::to_string(w.height);
    json += "},\"layer\":0,\"alpha\":";
    // Emit alpha as either 1 or a 0..1 fraction. Keep it simple and
    // deterministic: 1 for opaque, otherwise three decimals.
    if (w.alpha >= 1.0) {
      json += "1";
    } else {
      char buf[16];
      std::snprintf(buf, sizeof(buf), "%.3f", w.alpha);
      json += buf;
    }
    json += ",\"isFrontmostInApp\":";
    json += (w.isFrontmostInApp ? "true" : "false");
    json += '}';
  }
  json += "],\"frontmostPid\":";
  if (frontmostPid >= 0) {
    json += std::to_string(frontmostPid);
  } else {
    json += "null";
  }
  json += ",\"frontmostBundleId\":";
  AppendJsonStringOrNull(&json, frontmostExe);
  json += '}';

  // Write raw UTF-8 bytes to stdout. Set the CRT stdout to binary so the
  // \n-free payload isn't mangled by CRLF translation (there are no
  // newlines, but binary mode keeps the bytes byte-for-byte).
  _setmode(_fileno(stdout), _O_BINARY);
  std::fwrite(json.data(), 1, json.size(), stdout);
  std::fflush(stdout);
  return 0;
}
