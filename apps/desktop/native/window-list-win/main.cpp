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
//   - bounds        → the window's extended frame bounds in virtual-
//                     screen coordinates (top-left origin), matching
//                     Electron's `screen.getDisplay*()` global coord
//                     space — no remap needed. We prefer the DWM
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
// Build: cl.exe /O2 /EHsc /std:c++17 main.cpp /Fe:window-list.exe
//        user32.lib dwmapi.lib (compiled by
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

#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>

#include <io.h>
#include <fcntl.h>

namespace {

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

int wmain() {
  // Per-monitor DPI awareness so GetWindowRect / DWM bounds come back in
  // true physical pixels of the virtual-screen coordinate space rather
  // than being virtualized by the OS for a DPI-unaware process. This
  // matches the coordinate space the macOS helper reports and that
  // Electron's screen API expects. SetProcessDpiAwarenessContext is
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
