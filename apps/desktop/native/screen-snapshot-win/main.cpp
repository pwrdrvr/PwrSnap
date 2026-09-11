// PwrSnap Windows frozen-screen snapshot broker.
//
// `--create` owns one pagefile-backed CreateFileMappingW section for the
// lifetime of its stdin pipe. `--read` opens that section read-only, validates
// the complete versioned header, and streams one bounded header+pixel frame to
// stdout. Electron main is the broker: the unpredictable mapping name never
// crosses preload/contextBridge into the sandboxed renderer.
//
// The mapping DACL grants only FILE_MAP_READ to the current user. The creator's
// handle itself remains writable so it can populate the section, but no later
// opener (including another process running as the same user) can acquire a
// write view. The Local\ namespace prevents a cross-session/global object.
//
// Binary layout (all unsigned little-endian; fixed 64-byte header):
//   0   char[8]  "PWRSSNP\0"
//   8   u32      version = 1
//   12  u32      header bytes = 64
//   16  u32      width
//   20  u32      height
//   24  u32      stride = width * 4
//   28  u32      pixel format = 1 (RGBA8 sRGB, opaque, top-down)
//   32  u64      pixel byte length = stride * height
//   40  u64      total mapping byte length = 64 + pixel byte length
//   48  u8[16]   random per-snapshot nonce
//   64  u8[]     tightly packed R,G,B,A pixels; A is always 255

#define NOMINMAX
#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#include <algorithm>
#include <array>
#include <cerrno>
#include <cstdint>
#include <cstring>
#include <cwchar>
#include <iostream>
#include <limits>
#include <string>
#include <vector>

namespace {

constexpr std::array<std::uint8_t, 8> kMagic = {
    0x50, 0x57, 0x52, 0x53, 0x53, 0x4e, 0x50, 0x00};
constexpr std::uint32_t kVersion = 1;
constexpr std::uint32_t kHeaderBytes = 64;
constexpr std::uint32_t kPixelFormatRgba8SrgbOpaque = 1;
constexpr std::uint32_t kBytesPerPixel = 4;
constexpr std::uint32_t kMaxDimension = 32768;
constexpr std::uint64_t kMaxPayloadBytes = 512ull * 1024ull * 1024ull;
constexpr wchar_t kMappingPrefix[] = L"Local\\PwrSnapSnapshot-";

struct Layout {
  std::uint32_t width = 0;
  std::uint32_t height = 0;
  std::uint32_t stride = 0;
  std::uint64_t payloadBytes = 0;
  std::uint64_t totalBytes = 0;
};

void fail(const wchar_t* code) {
  std::wcerr << code << L"\n";
  std::wcerr.flush();
}

bool parseU32(const wchar_t* text, std::uint32_t* out) {
  if (text == nullptr || *text == L'\0') return false;
  wchar_t* end = nullptr;
  errno = 0;
  const unsigned long long value = std::wcstoull(text, &end, 10);
  if (errno != 0 || end == text || *end != L'\0' ||
      value > std::numeric_limits<std::uint32_t>::max()) {
    return false;
  }
  *out = static_cast<std::uint32_t>(value);
  return true;
}

bool parseU64(const wchar_t* text, std::uint64_t* out) {
  if (text == nullptr || *text == L'\0') return false;
  wchar_t* end = nullptr;
  errno = 0;
  const unsigned long long value = std::wcstoull(text, &end, 10);
  if (errno != 0 || end == text || *end != L'\0') return false;
  *out = static_cast<std::uint64_t>(value);
  return true;
}

int hexValue(wchar_t value) {
  if (value >= L'0' && value <= L'9') return value - L'0';
  if (value >= L'a' && value <= L'f') return value - L'a' + 10;
  return -1;
}

bool parseNonce(const std::wstring& text, std::array<std::uint8_t, 16>* out) {
  if (text.size() != 32) return false;
  for (std::size_t i = 0; i < out->size(); ++i) {
    const int high = hexValue(text[i * 2]);
    const int low = hexValue(text[i * 2 + 1]);
    if (high < 0 || low < 0) return false;
    (*out)[i] = static_cast<std::uint8_t>((high << 4) | low);
  }
  return true;
}

bool validMappingName(const std::wstring& name,
                      const std::wstring& nonceText) {
  const std::wstring prefix(kMappingPrefix);
  return name == prefix + nonceText;
}

bool computeLayout(std::uint32_t width, std::uint32_t height,
                   std::uint32_t stride, Layout* out) {
  if (width == 0 || height == 0 || width > kMaxDimension ||
      height > kMaxDimension) {
    return false;
  }
  const std::uint64_t expectedStride =
      static_cast<std::uint64_t>(width) * kBytesPerPixel;
  if (expectedStride > std::numeric_limits<std::uint32_t>::max() ||
      stride != expectedStride) {
    return false;
  }
  if (static_cast<std::uint64_t>(height) >
      std::numeric_limits<std::uint64_t>::max() / expectedStride) {
    return false;
  }
  const std::uint64_t payload = expectedStride * height;
  if (payload == 0 || payload > kMaxPayloadBytes ||
      payload > std::numeric_limits<std::uint64_t>::max() - kHeaderBytes) {
    return false;
  }
  out->width = width;
  out->height = height;
  out->stride = stride;
  out->payloadBytes = payload;
  out->totalBytes = payload + kHeaderBytes;
  return true;
}

void writeU32(std::uint8_t* destination, std::uint32_t value) {
  destination[0] = static_cast<std::uint8_t>(value);
  destination[1] = static_cast<std::uint8_t>(value >> 8);
  destination[2] = static_cast<std::uint8_t>(value >> 16);
  destination[3] = static_cast<std::uint8_t>(value >> 24);
}

void writeU64(std::uint8_t* destination, std::uint64_t value) {
  for (int i = 0; i < 8; ++i) {
    destination[i] = static_cast<std::uint8_t>(value >> (i * 8));
  }
}

std::uint32_t readU32(const std::uint8_t* source) {
  return static_cast<std::uint32_t>(source[0]) |
         (static_cast<std::uint32_t>(source[1]) << 8) |
         (static_cast<std::uint32_t>(source[2]) << 16) |
         (static_cast<std::uint32_t>(source[3]) << 24);
}

std::uint64_t readU64(const std::uint8_t* source) {
  std::uint64_t value = 0;
  for (int i = 0; i < 8; ++i) {
    value |= static_cast<std::uint64_t>(source[i]) << (i * 8);
  }
  return value;
}

void writeHeader(std::uint8_t* view, const Layout& layout,
                 const std::array<std::uint8_t, 16>& nonce) {
  std::memset(view, 0, kHeaderBytes);
  std::memcpy(view, kMagic.data(), kMagic.size());
  writeU32(view + 8, kVersion);
  writeU32(view + 12, kHeaderBytes);
  writeU32(view + 16, layout.width);
  writeU32(view + 20, layout.height);
  writeU32(view + 24, layout.stride);
  writeU32(view + 28, kPixelFormatRgba8SrgbOpaque);
  writeU64(view + 32, layout.payloadBytes);
  writeU64(view + 40, layout.totalBytes);
  std::memcpy(view + 48, nonce.data(), nonce.size());
}

bool validateHeader(const std::uint8_t* view,
                    const std::array<std::uint8_t, 16>& expectedNonce,
                    std::uint64_t expectedTotal, Layout* layout) {
  if (std::memcmp(view, kMagic.data(), kMagic.size()) != 0 ||
      readU32(view + 8) != kVersion ||
      readU32(view + 12) != kHeaderBytes ||
      readU32(view + 28) != kPixelFormatRgba8SrgbOpaque ||
      std::memcmp(view + 48, expectedNonce.data(), expectedNonce.size()) != 0) {
    return false;
  }
  if (!computeLayout(readU32(view + 16), readU32(view + 20),
                     readU32(view + 24), layout)) {
    return false;
  }
  return readU64(view + 32) == layout->payloadBytes &&
         readU64(view + 40) == layout->totalBytes &&
         layout->totalBytes == expectedTotal;
}

bool readExact(HANDLE handle, std::uint8_t* destination,
               std::uint64_t byteLength) {
  std::uint64_t offset = 0;
  while (offset < byteLength) {
    const DWORD request = static_cast<DWORD>(
        (std::min)(byteLength - offset, static_cast<std::uint64_t>(1 << 20)));
    DWORD received = 0;
    if (!ReadFile(handle, destination + offset, request, &received, nullptr) ||
        received == 0) {
      return false;
    }
    offset += received;
  }
  return true;
}

bool writeExact(HANDLE handle, const std::uint8_t* source,
                std::uint64_t byteLength) {
  std::uint64_t offset = 0;
  while (offset < byteLength) {
    const DWORD request = static_cast<DWORD>(
        (std::min)(byteLength - offset, static_cast<std::uint64_t>(1 << 20)));
    DWORD written = 0;
    if (!WriteFile(handle, source + offset, request, &written, nullptr) ||
        written == 0) {
      return false;
    }
    offset += written;
  }
  return true;
}

bool buildCurrentUserReadOnlySecurity(
    SECURITY_ATTRIBUTES* attributes, SECURITY_DESCRIPTOR* descriptor,
    std::vector<std::uint8_t>* tokenStorage,
    std::vector<std::uint8_t>* aclStorage) {
  HANDLE token = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return false;
  DWORD required = 0;
  GetTokenInformation(token, TokenUser, nullptr, 0, &required);
  if (required == 0) {
    CloseHandle(token);
    return false;
  }
  tokenStorage->resize(required);
  if (!GetTokenInformation(token, TokenUser, tokenStorage->data(), required,
                           &required)) {
    CloseHandle(token);
    return false;
  }
  CloseHandle(token);
  const auto* tokenUser =
      reinterpret_cast<const TOKEN_USER*>(tokenStorage->data());
  const DWORD sidLength = GetLengthSid(tokenUser->User.Sid);
  const DWORD aclLength = sizeof(ACL) + sizeof(ACCESS_ALLOWED_ACE) -
                          sizeof(DWORD) + sidLength;
  aclStorage->resize(aclLength);
  auto* acl = reinterpret_cast<ACL*>(aclStorage->data());
  if (!InitializeAcl(acl, aclLength, ACL_REVISION) ||
      !AddAccessAllowedAce(acl, ACL_REVISION, FILE_MAP_READ,
                           tokenUser->User.Sid) ||
      !InitializeSecurityDescriptor(descriptor,
                                    SECURITY_DESCRIPTOR_REVISION) ||
      !SetSecurityDescriptorDacl(descriptor, TRUE, acl, FALSE)) {
    return false;
  }
  attributes->nLength = sizeof(SECURITY_ATTRIBUTES);
  attributes->lpSecurityDescriptor = descriptor;
  attributes->bInheritHandle = FALSE;
  return true;
}

int createMapping(int argc, wchar_t* argv[]) {
  if (argc != 8) {
    fail(L"invalid_arguments");
    return 2;
  }
  const std::wstring mappingName(argv[2]);
  const std::wstring nonceText(argv[3]);
  std::array<std::uint8_t, 16> nonce{};
  std::uint32_t width = 0, height = 0, stride = 0;
  Layout layout;
  if (!validMappingName(mappingName, nonceText) ||
      !parseNonce(nonceText, &nonce) || !parseU32(argv[4], &width) ||
      !parseU32(argv[5], &height) || !parseU32(argv[6], &stride) ||
      !computeLayout(width, height, stride, &layout)) {
    fail(L"invalid_layout");
    return 3;
  }
  const std::wstring inputFormat(argv[7]);
  const bool inputBgra = inputFormat == L"bgra8";
  if (!inputBgra && inputFormat != L"rgba8") {
    fail(L"invalid_pixel_format");
    return 4;
  }

  SECURITY_ATTRIBUTES attributes{};
  SECURITY_DESCRIPTOR descriptor{};
  std::vector<std::uint8_t> tokenStorage;
  std::vector<std::uint8_t> aclStorage;
  if (!buildCurrentUserReadOnlySecurity(&attributes, &descriptor,
                                        &tokenStorage, &aclStorage)) {
    fail(L"security_descriptor_failed");
    return 5;
  }

  const DWORD high = static_cast<DWORD>(layout.totalBytes >> 32);
  const DWORD low = static_cast<DWORD>(layout.totalBytes & 0xffffffffull);
  HANDLE mapping = CreateFileMappingW(INVALID_HANDLE_VALUE, &attributes,
                                      PAGE_READWRITE, high, low,
                                      mappingName.c_str());
  if (mapping == nullptr) {
    fail(L"create_mapping_failed");
    return 6;
  }
  if (GetLastError() == ERROR_ALREADY_EXISTS) {
    CloseHandle(mapping);
    fail(L"mapping_collision");
    return 7;
  }
  auto* view = static_cast<std::uint8_t*>(MapViewOfFile(
      mapping, FILE_MAP_WRITE, 0, 0,
      static_cast<SIZE_T>(layout.totalBytes)));
  if (view == nullptr) {
    CloseHandle(mapping);
    fail(L"map_view_failed");
    return 8;
  }
  std::memset(view, 0, kHeaderBytes);
  if (!readExact(GetStdHandle(STD_INPUT_HANDLE), view + kHeaderBytes,
                 layout.payloadBytes)) {
    UnmapViewOfFile(view);
    CloseHandle(mapping);
    fail(L"pixel_input_truncated");
    return 9;
  }
  for (std::uint64_t offset = 0; offset < layout.payloadBytes;
       offset += kBytesPerPixel) {
    if (inputBgra) {
      const std::uint8_t blue = view[kHeaderBytes + offset];
      view[kHeaderBytes + offset] = view[kHeaderBytes + offset + 2];
      view[kHeaderBytes + offset + 2] = blue;
    }
    view[kHeaderBytes + offset + 3] = 0xff;
  }
  // Publish the header LAST. Readers are not launched until the ready line,
  // but this ordering also makes an accidentally early opener reject zeros.
  writeHeader(view, layout, nonce);
  FlushViewOfFile(view, static_cast<SIZE_T>(layout.totalBytes));
  std::cout << "{\"ok\":true,\"version\":1,\"width\":" << width
            << ",\"height\":" << height << ",\"stride\":" << stride
            << ",\"byteLength\":\"" << layout.payloadBytes
            << "\",\"totalByteLength\":\"" << layout.totalBytes
            << "\"}\n";
  std::cout.flush();

  // Parent release writes one line. Parent crash/forced shutdown closes the
  // pipe; EOF is also release, so the kernel mapping cannot be orphaned.
  char byte = 0;
  DWORD received = 0;
  while (ReadFile(GetStdHandle(STD_INPUT_HANDLE), &byte, 1, &received, nullptr) &&
         received == 1 && byte != '\n') {
  }
  UnmapViewOfFile(view);
  CloseHandle(mapping);
  return 0;
}

int readMapping(int argc, wchar_t* argv[]) {
  if (argc != 5) {
    fail(L"invalid_arguments");
    return 20;
  }
  const std::wstring mappingName(argv[2]);
  const std::wstring nonceText(argv[3]);
  std::array<std::uint8_t, 16> nonce{};
  std::uint64_t expectedTotal = 0;
  if (!validMappingName(mappingName, nonceText) ||
      !parseNonce(nonceText, &nonce) ||
      !parseU64(argv[4], &expectedTotal) ||
      expectedTotal < kHeaderBytes ||
      expectedTotal > kMaxPayloadBytes + kHeaderBytes) {
    fail(L"invalid_read_request");
    return 21;
  }
  HANDLE mapping = OpenFileMappingW(FILE_MAP_READ, FALSE, mappingName.c_str());
  if (mapping == nullptr) {
    fail(L"open_mapping_failed");
    return 22;
  }
  auto* headerView = static_cast<const std::uint8_t*>(
      MapViewOfFile(mapping, FILE_MAP_READ, 0, 0, kHeaderBytes));
  if (headerView == nullptr) {
    CloseHandle(mapping);
    fail(L"map_header_failed");
    return 23;
  }
  Layout layout;
  const bool headerValid =
      validateHeader(headerView, nonce, expectedTotal, &layout);
  UnmapViewOfFile(headerView);
  if (!headerValid) {
    CloseHandle(mapping);
    fail(L"invalid_header");
    return 24;
  }
  auto* view = static_cast<const std::uint8_t*>(MapViewOfFile(
      mapping, FILE_MAP_READ, 0, 0, static_cast<SIZE_T>(layout.totalBytes)));
  if (view == nullptr || !validateHeader(view, nonce, expectedTotal, &layout)) {
    if (view != nullptr) UnmapViewOfFile(view);
    CloseHandle(mapping);
    fail(L"invalid_mapping");
    return 25;
  }
  const bool wrote = writeExact(GetStdHandle(STD_OUTPUT_HANDLE), view,
                                layout.totalBytes);
  UnmapViewOfFile(view);
  CloseHandle(mapping);
  if (!wrote) {
    fail(L"output_failed");
    return 26;
  }
  return 0;
}

}  // namespace

int wmain(int argc, wchar_t* argv[]) {
  if (argc < 2) {
    fail(L"missing_command");
    return 1;
  }
  const std::wstring command(argv[1]);
  if (command == L"--create") return createMapping(argc, argv);
  if (command == L"--read") return readMapping(argc, argv);
  fail(L"unknown_command");
  return 1;
}
