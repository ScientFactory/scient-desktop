# ZIP policy must run inside the reader: libarchive can decompress symlinks
# during next_header(), before the caller can inspect the entry.
include(FetchContent)
set(SCIC_ARCHIVE_URL "https://libarchive.org/downloads/libarchive-3.8.7.tar.gz")
set(SCIC_ARCHIVE_HASH "4b787cca6697a95c7725e45293c973c208cbdc71ae2279f30ef09f52472b9166")
FetchContent_Declare(scic_libarchive
  URL "${SCIC_ARCHIVE_URL}"
  URL_HASH "SHA256=${SCIC_ARCHIVE_HASH}"
  DOWNLOAD_EXTRACT_TIMESTAMP TRUE
  PATCH_COMMAND "${CMAKE_COMMAND}" -DSOURCE_DIR=<SOURCE_DIR>
    -P "${CMAKE_CURRENT_LIST_DIR}/PatchArchive.cmake")

# No optional codecs, crypto, external programs or package-manager libraries.
# The ZIP boundary patch is still required even with these features disabled.
foreach(feature MBEDTLS NETTLE OPENSSL LIBB2 LZ4 LZO LZMA ZSTD BZip2 LIBXML2
    EXPAT WIN32_XMLLITE PCREPOSIX PCRE2POSIX LIBGCC CNG TAR CPIO CAT UNZIP
    XATTR ACL ICONV TEST COVERAGE INSTALL)
  set(ENABLE_${feature} OFF CACHE BOOL "" FORCE)
endforeach()
set(ENABLE_ZLIB ON CACHE BOOL "" FORCE)
set(BUILD_SHARED_LIBS OFF CACHE BOOL "" FORCE)
set(MSVC_USE_STATIC_CRT ON CACHE BOOL "" FORCE)
set(DONT_FAIL_ON_CRC_ERROR OFF CACHE BOOL "" FORCE)
find_package(ZLIB REQUIRED)
FetchContent_MakeAvailable(scic_libarchive)
set_target_properties(archive_static PROPERTIES POSITION_INDEPENDENT_CODE ON
  ARCHIVE_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/scic-archive")
target_compile_definitions(archive_static INTERFACE LIBARCHIVE_STATIC)
