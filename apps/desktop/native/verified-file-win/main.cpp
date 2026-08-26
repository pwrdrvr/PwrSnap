#define _WIN32_WINNT 0x0602
#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#include <cstdint>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>

namespace {

void writeError(const char* code) {
  std::cout << "{\"ok\":false,\"code\":\"" << code << "\"}\n";
  std::cout.flush();
}

std::wstring utf8ToWide(const std::string& value) {
  if (value.empty()) return {};
  const int size = MultiByteToWideChar(
      CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
      static_cast<int>(value.size()), nullptr, 0);
  if (size <= 0) return {};
  std::wstring result(static_cast<size_t>(size), L'\0');
  if (MultiByteToWideChar(
          CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
          static_cast<int>(value.size()), result.data(), size) != size) {
    return {};
  }
  return result;
}

std::string wideToUtf8(const std::wstring& value) {
  if (value.empty()) return {};
  const int size = WideCharToMultiByte(
      CP_UTF8, WC_ERR_INVALID_CHARS, value.data(),
      static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
  if (size <= 0) return {};
  std::string result(static_cast<size_t>(size), '\0');
  if (WideCharToMultiByte(
          CP_UTF8, WC_ERR_INVALID_CHARS, value.data(),
          static_cast<int>(value.size()), result.data(), size, nullptr,
          nullptr) != size) {
    return {};
  }
  return result;
}

std::string jsonEscape(const std::string& value) {
  std::ostringstream escaped;
  for (const unsigned char ch : value) {
    switch (ch) {
      case '\\': escaped << "\\\\"; break;
      case '"': escaped << "\\\""; break;
      case '\b': escaped << "\\b"; break;
      case '\f': escaped << "\\f"; break;
      case '\n': escaped << "\\n"; break;
      case '\r': escaped << "\\r"; break;
      case '\t': escaped << "\\t"; break;
      default:
        if (ch < 0x20) {
          static constexpr char hex[] = "0123456789abcdef";
          escaped << "\\u00" << hex[(ch >> 4) & 0x0f] << hex[ch & 0x0f];
        } else {
          escaped << static_cast<char>(ch);
        }
    }
  }
  return escaped.str();
}

}  // namespace

int main() {
  std::ios::sync_with_stdio(false);

  // The path arrives over stdin so a private absolute pathname never appears
  // in the helper process's command line or in its path-free diagnostics.
  std::string utf8Path;
  if (!std::getline(std::cin, utf8Path) || utf8Path.empty() ||
      utf8Path.size() > 32767) {
    writeError("invalid_path");
    return 2;
  }
  if (!utf8Path.empty() && utf8Path.back() == '\r') utf8Path.pop_back();
  const std::wstring path = utf8ToWide(utf8Path);
  if (path.empty()) {
    writeError("invalid_path");
    return 2;
  }

  // FILE_FLAG_OPEN_REPARSE_POINT makes the final-component check atomic:
  // CreateFileW opens the link/reparse object itself rather than following it.
  // FILE_SHARE_READ deliberately withholds write/delete sharing while the
  // parent validates and opens its Node handle, so the leaf cannot be swapped
  // between the native proof and that second read-only open.
  HANDLE handle = CreateFileW(
      path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING,
      FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_SEQUENTIAL_SCAN,
      nullptr);
  if (handle == INVALID_HANDLE_VALUE) {
    writeError("open_failed");
    return 3;
  }

  FILE_ATTRIBUTE_TAG_INFO tagInfo{};
  if (!GetFileInformationByHandleEx(
          handle, FileAttributeTagInfo, &tagInfo, sizeof(tagInfo))) {
    CloseHandle(handle);
    writeError("stat_failed");
    return 4;
  }
  if ((tagInfo.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
    CloseHandle(handle);
    writeError("symlink");
    return 5;
  }
  if ((tagInfo.FileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0 ||
      GetFileType(handle) != FILE_TYPE_DISK) {
    CloseHandle(handle);
    writeError("not_regular_file");
    return 6;
  }

  BY_HANDLE_FILE_INFORMATION info{};
  if (!GetFileInformationByHandle(handle, &info)) {
    CloseHandle(handle);
    writeError("stat_failed");
    return 7;
  }

  std::vector<wchar_t> finalPathBuffer(32768, L'\0');
  const DWORD finalLength = GetFinalPathNameByHandleW(
      handle, finalPathBuffer.data(),
      static_cast<DWORD>(finalPathBuffer.size()), 0);
  if (finalLength == 0 || finalLength >= finalPathBuffer.size()) {
    CloseHandle(handle);
    writeError("canonicalize_failed");
    return 8;
  }
  const std::wstring finalWide(finalPathBuffer.data(), finalLength);
  const std::string finalPath = wideToUtf8(finalWide);
  if (finalPath.empty()) {
    CloseHandle(handle);
    writeError("canonicalize_failed");
    return 8;
  }

  const std::uint64_t fileIndex =
      (static_cast<std::uint64_t>(info.nFileIndexHigh) << 32) |
      info.nFileIndexLow;
  const std::uint64_t fileSize =
      (static_cast<std::uint64_t>(info.nFileSizeHigh) << 32) |
      info.nFileSizeLow;

  std::cout << "{\"ok\":true,\"finalPath\":\""
            << jsonEscape(finalPath) << "\",\"size\":\"" << fileSize
            << "\",\"dev\":\"" << info.dwVolumeSerialNumber
            << "\",\"ino\":\"" << fileIndex << "\"}\n";
  std::cout.flush();

  // Keep the non-share-delete/non-share-write lease alive until the parent
  // has finished its callback and final fstat. EOF is also a valid abort.
  std::string release;
  (void)std::getline(std::cin, release);
  CloseHandle(handle);
  return 0;
}
