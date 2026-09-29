#include "scic_preview.h"
#include <archive.h>
#include <archive_entry.h>
#include <json-c/json.h>
#ifdef __APPLE__
#include <CommonCrypto/CommonDigest.h>
#elif defined(_WIN32)
#include <bcrypt.h>
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#else
#include <openssl/evp.h>
#endif
#include <algorithm>
#include <chrono>
#include <cctype>
#include <climits>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <memory>
#include <set>
#include <stdexcept>
#include <string>
#ifndef _WIN32
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>
#endif

namespace {
constexpr const char *kMediaType = "application/vnd.scient.conversation+zip";
constexpr size_t kMaxManifest = 16 * 1024 * 1024;
// Preview has a deliberately smaller memory budget than the 128 MiB import
// limit. Large valid files remain importable in Scient.
constexpr size_t kMaxSnapshot = 16 * 1024 * 1024;
constexpr size_t kMaxOutput = 256 * 1024;
constexpr int kMaxEntries = 10000;
constexpr long long kMaxArchive = 768LL * 1024 * 1024;
constexpr long long kMaxDeclared = 720LL * 1024 * 1024;
constexpr auto kTimeBudget = std::chrono::seconds(5);
using Clock = std::chrono::steady_clock;

void checkTime(Clock::time_point deadline) {
  if (Clock::now() >= deadline) throw std::runtime_error("Conversation preview timed out");
}

using Archive = std::unique_ptr<archive, decltype(&archive_read_free)>;
using Json = std::unique_ptr<json_object, decltype(&json_object_put)>;
using Tokener = std::unique_ptr<json_tokener, decltype(&json_tokener_free)>;

std::string field(json_object *object, const char *key) {
  json_object *value = nullptr;
  if (!object || !json_object_is_type(object, json_type_object) ||
      !json_object_object_get_ex(object, key, &value) ||
      !json_object_is_type(value, json_type_string))
    throw std::runtime_error(std::string("Invalid ") + key + " field");
  return {json_object_get_string(value), static_cast<size_t>(json_object_get_string_len(value))};
}

bool validUtf8(const std::string &value) {
  for (size_t index = 0; index < value.size();) {
    const unsigned char first = static_cast<unsigned char>(value[index]);
    if (first < 0x80) { ++index; continue; }
    const size_t width = first >= 0xc2 && first <= 0xdf ? 2 :
                         first >= 0xe0 && first <= 0xef ? 3 :
                         first >= 0xf0 && first <= 0xf4 ? 4 : 0;
    if (!width || index + width > value.size()) return false;
    for (size_t offset = 1; offset < width; ++offset) {
      if ((static_cast<unsigned char>(value[index + offset]) & 0xc0) != 0x80) return false;
    }
    const unsigned char second = static_cast<unsigned char>(value[index + 1]);
    if ((first == 0xe0 && second < 0xa0) || (first == 0xed && second >= 0xa0) ||
        (first == 0xf0 && second < 0x90) || (first == 0xf4 && second >= 0x90)) return false;
    index += width;
  }
  return true;
}

json_object *required(json_object *object, const char *key, json_type type) {
  json_object *value = nullptr;
  if (!object || !json_object_is_type(object, json_type_object) ||
      !json_object_object_get_ex(object, key, &value) ||
      !json_object_is_type(value, type))
    throw std::runtime_error(std::string("Invalid ") + key + " field");
  return value;
}

Json parse(const std::string &bytes) {
  Tokener tok(json_tokener_new_ex(32), json_tokener_free);
  if (!tok) throw std::bad_alloc();
  json_object *raw = json_tokener_parse_ex(tok.get(), bytes.data(), static_cast<int>(bytes.size()));
  Json result(raw, json_object_put);
  if (!raw || json_tokener_get_error(tok.get()) != json_tokener_success ||
      json_tokener_get_parse_end(tok.get()) != bytes.size())
    throw std::runtime_error("Malformed JSON");
  return result;
}

bool safePath(const std::string &name) {
  if (name.empty() || name.size() > 512 || name.front() == '/' ||
      name.find('\\') != std::string::npos ||
      (name.size() > 1 && std::isalpha(static_cast<unsigned char>(name[0])) && name[1] == ':'))
    return false;
  size_t start = 0;
  while (start < name.size()) {
    size_t end = name.find('/', start);
    if (end == std::string::npos) end = name.size();
    const auto part = name.substr(start, end - start);
    if (part.empty() || part == "." || part == "..") return false;
    start = end + 1;
  }
  for (unsigned char c : name) if (c < 32 || c == 127) return false;
  return true;
}

std::string readMember(archive *reader, size_t limit) {
  std::string result;
  char buffer[32768];
  for (;;) {
    const la_ssize_t count = archive_read_data(reader, buffer, sizeof(buffer));
    if (count < 0) throw std::runtime_error("Damaged ZIP member");
    if (count == 0) break;
    if (static_cast<size_t>(count) > limit - result.size())
      throw std::runtime_error("ZIP member exceeds preview limit");
    result.append(buffer, static_cast<size_t>(count));
  }
  return result;
}

std::string sha256(const std::string &bytes) {
  unsigned char digest[32]{};
#ifdef __APPLE__
  if (!CC_SHA256(bytes.data(), static_cast<CC_LONG>(bytes.size()), digest))
    throw std::runtime_error("Cannot check conversation digest");
#elif defined(_WIN32)
  BCRYPT_ALG_HANDLE algorithm = nullptr;
  if (!BCRYPT_SUCCESS(BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM,
                                                  nullptr, 0)))
    throw std::runtime_error("Cannot open SHA-256 provider");
  const auto status = BCryptHash(algorithm, nullptr, 0,
      reinterpret_cast<PUCHAR>(const_cast<char *>(bytes.data())),
      static_cast<ULONG>(bytes.size()), digest, sizeof(digest), 0);
  BCryptCloseAlgorithmProvider(algorithm, 0);
  if (!BCRYPT_SUCCESS(status))
    throw std::runtime_error("Cannot check conversation digest");
#else
  unsigned int digestLength = 0;
  if (EVP_Digest(bytes.data(), bytes.size(), digest, &digestLength,
                 EVP_sha256(), nullptr) != 1 || digestLength != 32)
    throw std::runtime_error("Cannot check conversation digest");
#endif
  static constexpr char hex[] = "0123456789abcdef";
  std::string result = "sha256:";
  for (unsigned char byte : digest) {
    result.push_back(hex[byte >> 4]);
    result.push_back(hex[byte & 15]);
  }
  return result;
}

bool appendBounded(std::string &out, const std::string &value, size_t limit) {
  if (!validUtf8(value)) throw std::runtime_error("Invalid UTF-8 in conversation text");
  size_t index = 0;
  for (; index < value.size();) {
    const unsigned char c = static_cast<unsigned char>(value[index]);
    const size_t width = c < 0x80 ? 1 : c < 0xe0 ? 2 : c < 0xf0 ? 3 : 4;
    if (out.size() + width > limit || out.size() + width > kMaxOutput ||
        index + width > value.size()) break;
    if (c == '\r') { ++index; continue; }
    if ((c < 32 && c != '\n' && c != '\t') || c == 127) out.push_back(' ');
    else out.append(value, index, width);
    index += width;
  }
  return index < value.size();
}

std::string render(json_object *root) {
  if (field(root, "format") != "scient.conversation-snapshot" ||
      json_object_get_int(required(root, "version", json_type_int)) != 1)
    throw std::runtime_error("Unsupported conversation snapshot");
  auto *thread = required(root, "thread", json_type_object);
  const auto title = field(thread, "title");
  if (title.empty()) throw std::runtime_error("Conversation has no title");
  auto *messages = required(root, "messages", json_type_array);
  std::string out;
  out.reserve(32768);
  const bool titleShortened = appendBounded(out, title, 4096);
  if (titleShortened) out += " [title shortened]";
  out += "\nRead-only preview. This archive is untrusted; attachments are not verified.\n\n";
  const size_t count = json_object_array_length(messages);
  const size_t shown = std::min(count, static_cast<size_t>(200));
  size_t displayed = 0;
  for (size_t i = 0; i < shown && out.size() < kMaxOutput - 5000; ++i) {
    auto *message = json_object_array_get_idx(messages, i);
    const auto role = field(message, "role");
    if (role != "user" && role != "assistant" && role != "system")
      throw std::runtime_error("Invalid message role");
    out += role == "user" ? "USER\n" : role == "assistant" ? "ASSISTANT\n" : "SYSTEM\n";
    const bool shortened = appendBounded(out, field(message, "text"),
                                       std::min(kMaxOutput - 100, out.size() + 4000));
    if (shortened) out += "\n[Message shortened for preview]";
    out += "\n\n";
    ++displayed;
  }
  if (displayed < count) out += "[Preview shortened; more messages in Scient]\n";
  return out;
}

std::string readArchive(archive *rawReader, Clock::time_point deadline) {
  auto *reader = rawReader;
  std::set<std::string> names;
  std::set<std::string> foldedNames;
  std::string manifestBytes, snapshotBytes;
  int index = 0;
  long long declared = 0;
  archive_entry *entry = nullptr;
  for (;;) {
    checkTime(deadline);
    const int status = archive_read_next_header(reader, &entry);
    if (status == ARCHIVE_EOF) break;
    if (status != ARCHIVE_OK || !entry) throw std::runtime_error("Damaged ZIP directory");
    if (archive_format(reader) != ARCHIVE_FORMAT_ZIP)
      throw std::runtime_error("Expected a ZIP archive");
    if (++index > kMaxEntries) throw std::runtime_error("Too many ZIP entries");
    const char *nameRaw = archive_entry_pathname_utf8(entry);
    if (!nameRaw) throw std::runtime_error("Invalid ZIP entry name");
    std::string name(nameRaw);
    if (!safePath(name) || archive_entry_filetype(entry) != AE_IFREG ||
        archive_entry_is_encrypted(entry))
      throw std::runtime_error("Unsafe ZIP entry");
    std::string folded = name;
    for (char &character : folded)
      character = static_cast<char>(std::tolower(static_cast<unsigned char>(character)));
    if (!names.insert(name).second || !foldedNames.insert(folded).second)
      throw std::runtime_error("Duplicate ZIP entry");
    const la_int64_t size = archive_entry_size(entry);
    if (size < 0 || size > kMaxDeclared - declared)
      throw std::runtime_error("ZIP exceeds declared size limit");
    declared += size;
    if (index == 1) {
      if (name != "mimetype" || size != static_cast<long long>(std::strlen(kMediaType)) ||
          readMember(reader, std::strlen(kMediaType)) != kMediaType)
        throw std::runtime_error("Invalid conversation mimetype");
    } else if (name == "mimetype") {
      throw std::runtime_error("Duplicate conversation mimetype");
    } else if (name == "manifest.json") {
      if (size > static_cast<long long>(kMaxManifest)) throw std::runtime_error("Manifest too large");
      manifestBytes = readMember(reader, kMaxManifest);
    } else if (name == "conversation.json") {
      if (size > static_cast<long long>(kMaxSnapshot)) throw std::runtime_error("Conversation too large for preview");
      snapshotBytes = readMember(reader, kMaxSnapshot);
    } else {
      if (name != "conversation.md" && name.rfind("attachments/", 0) != 0)
        throw std::runtime_error("Unknown ZIP entry");
      if (archive_read_data_skip(reader) != ARCHIVE_OK)
        throw std::runtime_error("Damaged ZIP entry");
    }
  }
  if (index < 4 || manifestBytes.empty() || snapshotBytes.empty())
    throw std::runtime_error("Incomplete conversation ZIP");
  checkTime(deadline);
  Json manifest = parse(manifestBytes);
  if (field(manifest.get(), "format") != "scient.conversation-file")
    throw std::runtime_error("Unsupported manifest");
  auto *version = required(manifest.get(), "formatVersion", json_type_object);
  if (json_object_get_int(required(version, "major", json_type_int)) != 1)
    throw std::runtime_error("Unsupported manifest version");
  auto *entries = required(manifest.get(), "entries", json_type_array);
  bool listedSnapshot = false;
  std::set<std::string> declaredNames{"mimetype", "manifest.json"};
  std::set<std::string> declaredFolded{"mimetype", "manifest.json"};
  for (size_t i = 0; i < json_object_array_length(entries); ++i) {
    auto *item = json_object_array_get_idx(entries, i);
    const auto memberName = field(item, "path");
    std::string folded = memberName;
    for (char &character : folded)
      character = static_cast<char>(std::tolower(static_cast<unsigned char>(character)));
    if (!safePath(memberName) || !declaredNames.insert(memberName).second ||
        !declaredFolded.insert(folded).second)
      throw std::runtime_error("Invalid manifest entry");
    if (memberName == "conversation.json") {
      if (listedSnapshot || json_object_get_int64(required(item, "byteLength", json_type_int)) !=
                                static_cast<int64_t>(snapshotBytes.size()))
        throw std::runtime_error("Manifest does not match conversation");
      const std::string expected = field(item, "sha256");
      if (sha256(snapshotBytes) != expected) throw std::runtime_error("Conversation digest mismatch");
      listedSnapshot = true;
    }
  }
  if (!listedSnapshot || !names.count("conversation.md") || names != declaredNames)
    throw std::runtime_error("Missing conversation document");
  Json snapshot = parse(snapshotBytes);
  checkTime(deadline);
  auto text = render(snapshot.get());
  checkTime(deadline);
  return text;
}

struct StreamInput {
  void *context;
  scic_preview_read_callback read;
  scic_preview_skip_callback skip;
  long long remaining;
  Clock::time_point deadline;
  char buffer[65536];
};

la_ssize_t streamRead(archive *, void *opaque, const void **buffer) {
  auto *source = static_cast<StreamInput *>(opaque);
  if (Clock::now() >= source->deadline) return -1;
  const auto request = static_cast<unsigned long>(std::min(source->remaining,
                                                       static_cast<long long>(sizeof(source->buffer))));
  const long long count = source->read(source->context, source->buffer, request);
  if (count < 0 || count > request) return -1;
  source->remaining -= count;
  *buffer = source->buffer;
  return static_cast<la_ssize_t>(count);
}

la_int64_t streamSkip(archive *, void *opaque, la_int64_t amount) {
  auto *source = static_cast<StreamInput *>(opaque);
  if (Clock::now() >= source->deadline) return -1;
  if (!source->skip || amount < 0) return 0;
  const auto request = std::min<long long>(amount, source->remaining);
  const auto skipped = source->skip(source->context, request);
  if (skipped < 0 || skipped > request) return -1;
  source->remaining -= skipped;
  return skipped;
}

std::string readStream(void *context, long long length,
                       scic_preview_read_callback readCallback,
                       scic_preview_skip_callback skipCallback) {
  if (!context || !readCallback || length < 0 || length > kMaxArchive)
    throw std::runtime_error("Conversation ZIP exceeds preview file limit");
  Archive reader(archive_read_new(), archive_read_free);
  if (!reader) throw std::bad_alloc();
  archive_read_support_filter_none(reader.get());
  archive_read_support_format_zip_streamable(reader.get());
  const auto deadline = Clock::now() + kTimeBudget;
  StreamInput input{context, readCallback, skipCallback, length, deadline, {}};
  if (archive_read_open2(reader.get(), &input, nullptr, streamRead, streamSkip, nullptr) != ARCHIVE_OK)
    throw std::runtime_error("Cannot open conversation ZIP");
  return readArchive(reader.get(), deadline);
}

long long fileRead(void *context, void *buffer, unsigned long length) {
  auto *file = static_cast<FILE *>(context);
  const size_t count = std::fread(buffer, 1, length, file);
  return std::ferror(file) ? -1 : static_cast<long long>(count);
}

long long fileSkip(void *context, long long amount) {
  if (amount < 0) return 0;
  auto *file = static_cast<FILE *>(context);
#ifdef _WIN32
  return _fseeki64(file, amount, SEEK_CUR) == 0 ? amount : 0;
#else
  return fseeko(file, amount, SEEK_CUR) == 0 ? amount : 0;
#endif
}

std::string read(const char *path) {
  if (!path || !*path) throw std::runtime_error("Missing file path");
#ifdef _WIN32
  const int length = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, path, -1, nullptr, 0);
  if (!length) throw std::runtime_error("Invalid UTF-8 file path");
  std::wstring widePath(length, L'\0');
  if (!MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, path, -1,
                           widePath.data(), length))
    throw std::runtime_error("Invalid UTF-8 file path");
  HANDLE file = CreateFileW(widePath.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_DELETE,
                            nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
  if (file == INVALID_HANDLE_VALUE) throw std::runtime_error("Cannot open conversation file");
  struct HandleCloser { HANDLE value; ~HandleCloser() { CloseHandle(value); } };
  HandleCloser owned{file};
  FILE_ATTRIBUTE_TAG_INFO attributes{};
  LARGE_INTEGER size{};
  if (GetFileType(file) != FILE_TYPE_DISK ||
      !GetFileInformationByHandleEx(file, FileAttributeTagInfo, &attributes, sizeof(attributes)) ||
      (attributes.FileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) ||
      !GetFileSizeEx(file, &size) || size.QuadPart < 0 || size.QuadPart > kMaxArchive)
    throw std::runtime_error("Expected a bounded regular conversation file");
  auto handleRead = [](void *opaque, void *buffer, unsigned long count) -> long long {
    DWORD received = 0;
    return ReadFile(opaque, buffer, count, &received, nullptr) ? received : -1;
  };
  auto handleSkip = [](void *opaque, long long count) -> long long {
    LARGE_INTEGER distance{};
    distance.QuadPart = count;
    return SetFilePointerEx(opaque, distance, nullptr, FILE_CURRENT) ? count : -1;
  };
  return readStream(file, size.QuadPart, handleRead, handleSkip);
#else
  const int descriptor = open(path, O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC);
  if (descriptor < 0) throw std::runtime_error("Cannot open conversation file");
  struct stat info{};
  if (fstat(descriptor, &info) != 0 || !S_ISREG(info.st_mode) ||
      info.st_size < 0 || info.st_size > kMaxArchive) {
    close(descriptor);
    throw std::runtime_error("Expected a bounded regular conversation file");
  }
  FILE *file = fdopen(descriptor, "rb");
  if (!file) {
    close(descriptor);
    throw std::runtime_error("Cannot read conversation file");
  }
  struct FileCloser { void operator()(FILE *f) const { std::fclose(f); } };
  std::unique_ptr<FILE, FileCloser> owned(file);
  return readStream(file, static_cast<long long>(info.st_size), fileRead, fileSkip);
#endif
}

char *copy(const std::string &value) {
  char *result = static_cast<char *>(std::malloc(value.size() + 1));
  if (!result) return nullptr;
  std::memcpy(result, value.c_str(), value.size() + 1);
  return result;
}
} // namespace

extern "C" int scic_preview_read(const char *path, char **text, char **error) {
  if (!text || !error) return 1;
  *text = nullptr;
  *error = nullptr;
  try {
    *text = copy(read(path));
    if (!*text) throw std::bad_alloc();
    return 0;
  } catch (const std::exception &cause) {
    *error = copy(cause.what());
    return 1;
  }
}

extern "C" int scic_preview_read_stream(void *context, long long length,
    scic_preview_read_callback readCallback, scic_preview_skip_callback skipCallback,
    char **text, char **error) {
  if (!text || !error) return 1;
  *text = nullptr;
  *error = nullptr;
  try {
    *text = copy(readStream(context, length, readCallback, skipCallback));
    if (!*text) throw std::bad_alloc();
    return 0;
  } catch (const std::exception &cause) {
    *error = copy(cause.what());
    return 1;
  }
}

extern "C" void scic_preview_free(char *value) { std::free(value); }
