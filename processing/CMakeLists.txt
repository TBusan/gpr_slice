cmake_minimum_required(VERSION 3.16)
project(gpr2gvt LANGUAGES CXX C)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)

if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release CACHE STRING "" FORCE)
endif()

if(MSVC)
  add_compile_options(/O2)
else()
  add_compile_options(-O2 -Wall)
endif()

# ---------------------------------------------------------------- zstd (vendored)
# 只编译单线程必需源文件，禁用 legacy/multithread。
set(ZSTD_ROOT ${CMAKE_CURRENT_SOURCE_DIR}/third_party/zstd/lib)
set(ZSTD_SOURCES
  ${ZSTD_ROOT}/common/debug.c
  ${ZSTD_ROOT}/common/entropy_common.c
  ${ZSTD_ROOT}/common/error_private.c
  ${ZSTD_ROOT}/common/fse_decompress.c
  ${ZSTD_ROOT}/common/xxhash.c
  ${ZSTD_ROOT}/common/zstd_common.c
  ${ZSTD_ROOT}/compress/fse_compress.c
  ${ZSTD_ROOT}/compress/hist.c
  ${ZSTD_ROOT}/compress/huf_compress.c
  ${ZSTD_ROOT}/compress/zstd_compress.c
  ${ZSTD_ROOT}/compress/zstd_compress_literals.c
  ${ZSTD_ROOT}/compress/zstd_compress_sequences.c
  ${ZSTD_ROOT}/compress/zstd_compress_superblock.c
  ${ZSTD_ROOT}/compress/zstd_double_fast.c
  ${ZSTD_ROOT}/compress/zstd_fast.c
  ${ZSTD_ROOT}/compress/zstd_lazy.c
  ${ZSTD_ROOT}/compress/zstd_ldm.c
  ${ZSTD_ROOT}/compress/zstd_opt.c
  ${ZSTD_ROOT}/decompress/huf_decompress.c
  ${ZSTD_ROOT}/decompress/zstd_ddict.c
  ${ZSTD_ROOT}/decompress/zstd_decompress.c
  ${ZSTD_ROOT}/decompress/zstd_decompress_block.c
)
add_library(zstd_static STATIC ${ZSTD_SOURCES})
target_include_directories(zstd_static PUBLIC ${ZSTD_ROOT})
# 注意：zstd 源码用 #if defined(ZSTD_MULTITHREAD) 守卫，必须"不定义"才是禁用。
target_compile_definitions(zstd_static PRIVATE ZSTD_LEGACY_SUPPORT=0)

# ---------------------------------------------------------------- gpr2gvt
set(SOURCES
  src/main.cpp
  src/iprh_parser.cpp
  src/ord_parser.cpp
  src/iprb_reader.cpp
  src/volume.cpp
  src/regularizer.cpp
  src/lod_generator.cpp
  src/tiler.cpp
  src/gvt_writer.cpp
  src/metadata_writer.cpp
)
add_executable(gpr2gvt ${SOURCES})
target_include_directories(gpr2gvt PRIVATE src ${CMAKE_CURRENT_SOURCE_DIR}/third_party)
target_link_libraries(gpr2gvt PRIVATE zstd_static)
if(WIN32)
  target_link_libraries(gpr2gvt PRIVATE shell32)
  # MinGW 静态链接运行时，避免 libstdc++-6.dll / libgcc_s_seh-1.dll 缺失
  if(NOT MSVC)
    target_link_options(gpr2gvt PRIVATE -static -static-libgcc -static-libstdc++)
  endif()
endif()
