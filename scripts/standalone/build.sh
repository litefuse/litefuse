#!/usr/bin/env bash
# One-shot standalone build for the current host platform: create a versioned
# release directory, download + unpack the matching DorisLite runtime, rebuild
# the Doris N-API addon, build the JS app, download a matching Node.js runtime,
# sync launch scripts + migrations, then pack it.
#
# Usage:
#   scripts/standalone/build.sh <output-dir>
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" # scripts/standalone
REPO="$(cd "$HERE/../.." && pwd)"
NATIVE_SRC_DIR="$REPO/web/src/server/doris/native"
DORIS_LITE_VERSION="${DORIS_LITE_VERSION:-4.0.5}"
DORIS_LITE_BASE_URL="${DORIS_LITE_BASE_URL:-https://apache-doris-releases.oss-accelerate.aliyuncs.com}"

[ "$#" -eq 1 ] || {
  echo "usage: build.sh <output-dir>" >&2
  exit 1
}

case "$(uname -s)" in
  Darwin)
    HOST_OS="darwin"
    PACKAGE_OS="macos"
    LIB_EXT="dylib"
    NODE_ARCHIVE_EXT="tar.gz"
    ;;
  Linux)
    HOST_OS="linux"
    PACKAGE_OS="linux"
    LIB_EXT="so"
    NODE_ARCHIVE_EXT="tar.xz"
    ;;
  *)
    echo "ERROR: unsupported host OS '$(uname -s)' (expected Darwin or Linux)" >&2
    exit 1
    ;;
esac

case "$(uname -m)" in
  x64|x86_64|amd64)
    HOST_ARCH="x64"
    ;;
  arm64|aarch64)
    HOST_ARCH="arm64"
    ;;
  *)
    echo "ERROR: unsupported host arch '$(uname -m)' (expected x86_64 or arm64)" >&2
    exit 1
    ;;
esac

PACKAGE_VERSION="$(node -e "const pkg = require(process.argv[1]); process.stdout.write(pkg.version);" "$REPO/package.json")"
RELEASE_NAME="litefuse-standalone-${PACKAGE_VERSION}-${PACKAGE_OS}-${HOST_ARCH}"
OUTPUT_DIR="$1"
mkdir -p "$OUTPUT_DIR"
OUTPUT_DIR="$(cd "$OUTPUT_DIR" && pwd)"
DIR="$OUTPUT_DIR/$RELEASE_NAME"
mkdir -p "$DIR"
DORIS_DIR="$DIR/doris"

clean_release_dir() {
  echo "==> cleaning release dir (preserving .env)"
  find "$DIR" -mindepth 1 -maxdepth 1 \
    ! -name ".env" \
    -exec rm -rf {} +
}

sync_env_template() {
  local template="$HERE/.env.template"

  [ -f "$template" ] || {
    echo "ERROR: standalone env template not found: $template" >&2
    exit 1
  }

  if [ -f "$DIR/.env" ]; then
    echo "==> preserving existing runtime env: $DIR/.env"
    return
  fi

  echo "==> creating default runtime env from $template"
  cp "$template" "$DIR/.env"
}

download_doris_runtime() {
  local archive url tarball tmp_extract top_count only_entry
  archive="apache-doris-lite-${DORIS_LITE_VERSION}-${PACKAGE_OS}-${HOST_ARCH}.tar.xz"
  url="${DORIS_LITE_BASE_URL}/${archive}"
  tarball="$DIR/$archive"
  tmp_extract="$(mktemp -d)"

  echo "==> downloading DorisLite ${DORIS_LITE_VERSION} (${PACKAGE_OS}-${HOST_ARCH})"
  echo "    url: $url"
  curl -fSL --retry 3 -o "$tarball" "$url"

  echo "==> unpacking DorisLite into $DORIS_DIR"
  rm -rf "$DORIS_DIR"
  tar -xJf "$tarball" -C "$tmp_extract"

  top_count="$(find "$tmp_extract" -mindepth 1 -maxdepth 1 | wc -l | tr -d ' ')"
  if [ "$top_count" = "1" ]; then
    only_entry="$(find "$tmp_extract" -mindepth 1 -maxdepth 1 | head -n1)"
    if [ -d "$only_entry" ]; then
      mv "$only_entry" "$DORIS_DIR"
    else
      mkdir -p "$DORIS_DIR"
      cp -R "$tmp_extract"/. "$DORIS_DIR"/
    fi
  else
    mkdir -p "$DORIS_DIR"
    cp -R "$tmp_extract"/. "$DORIS_DIR"/
  fi

  rm -rf "$tmp_extract"
  rm -f "$tarball"
}

build_native_addon() {
  echo "==> building doris_lite_embed.node for ${HOST_OS}-${HOST_ARCH}" >&2
  (
    cd "$NATIVE_SRC_DIR"
    npx node-gyp rebuild
  )
  [ -f "$NATIVE_SRC_DIR/build/Release/doris_lite_embed.node" ] || {
    echo "ERROR: node-gyp did not produce $NATIVE_SRC_DIR/build/Release/doris_lite_embed.node" >&2
    exit 1
  }
}

prepare_doris_runtime() {
  local native_dir="$DORIS_DIR/lib/native"
  local lib_path="$native_dir/libdoris_lite.$LIB_EXT"

  [ -d "$DORIS_DIR" ] || {
    echo "ERROR: $DORIS_DIR missing — DorisLite download or unpack failed" >&2
    exit 1
  }
  [ -d "$DORIS_DIR/jdk" ] || {
    echo "ERROR: $DORIS_DIR/jdk missing — DorisLite runtime is incomplete" >&2
    exit 1
  }
  [ -d "$DORIS_DIR/conf" ] || {
    echo "ERROR: $DORIS_DIR/conf missing — DorisLite runtime is incomplete" >&2
    exit 1
  }
  [ -d "$DORIS_DIR/lib" ] || {
    echo "ERROR: $DORIS_DIR/lib missing — DorisLite runtime is incomplete" >&2
    exit 1
  }

  echo "==> validating Doris runtime in $DORIS_DIR"
  [ -d "$native_dir" ] || {
    echo "ERROR: $native_dir missing — DorisLite runtime must provide lib/native/" >&2
    exit 1
  }

  [ -f "$lib_path" ] || {
    echo "ERROR: missing DorisLite shared library for ${PACKAGE_OS}-${HOST_ARCH}" >&2
    echo "  looked for: $lib_path" >&2
    echo "  build.sh only rebuilds doris_lite_embed.node automatically." >&2
    echo "  The downloaded DorisLite runtime must contain libdoris_lite.$LIB_EXT under doris/lib/native/." >&2
    exit 1
  }

  if [ "$HOST_OS" = "darwin" ]; then
    local expected_jvm="@loader_path/../../jdk/lib/server/libjvm.dylib"
    local current_jvm
    current_jvm="$(otool -L "$lib_path" | awk '/libjvm\.dylib/{print $1; exit}')"
    [ -n "$current_jvm" ] || {
      echo "ERROR: no libjvm.dylib reference found in $lib_path" >&2
      exit 1
    }
    if [ "$current_jvm" != "$expected_jvm" ]; then
      echo "==> repointing libjvm: $current_jvm -> $expected_jvm"
      install_name_tool -change "$current_jvm" "$expected_jvm" "$lib_path"
    fi
    codesign -f -s - "$lib_path" >/dev/null 2>&1 || true
  fi

  if [ "$HOST_OS" = "linux" ]; then
    [ -f "$native_dir/libdoris_jemalloc_preload.so" ] || {
      echo "ERROR: $native_dir/libdoris_jemalloc_preload.so missing — Linux DorisLite runtime is incomplete" >&2
      exit 1
    }
    [ -d "$native_dir/hadoop_native" ] || {
      echo "ERROR: $native_dir/hadoop_native missing — Linux DorisLite runtime is incomplete" >&2
      exit 1
    }
  fi
}

pack_release() {
  local name parent out
  name="$(basename "$DIR")"
  parent="$(dirname "$DIR")"
  out="$parent/$name.tar.xz"

  echo "==> cleaning runtime artifacts before packing"
  rm -f "$DIR/bin/litefuse.pid"
  rm -rf "$DIR/log" "$DIR/pglite"
  rm -rf "$DIR/doris/log/*" "$DIR/doris/storage/*" "$DIR/doris/doris-meta/*" "$DIR/doris/temp_dir"
  rm -rf "$DIR/doris/native"
  find "$DIR/doris/bin" -maxdepth 1 -type f -name '*.pid' -delete 2>/dev/null || true
  # Doris FE regenerates this on startup with an absolute LOG_DIR path; drop it
  # so the packaged tree carries no machine-specific path.
  rm -f "$DIR/doris/conf/log4j2-spring.xml"

  echo "==> packing $(basename "$DIR") -> $out"
  (cd "$parent" && tar -cf - "$name" | xz -T0 -z >"$out")
  ls -la "$out"
}

echo "==> host platform: ${PACKAGE_OS}-${HOST_ARCH} (node platform: ${HOST_OS}-${HOST_ARCH})"
echo "==> release dir: $DIR"
clean_release_dir
sync_env_template
download_doris_runtime
prepare_doris_runtime

echo "==> building web standalone (pnpm --filter=web build)"
(cd "$REPO" && pnpm install --frozen-lockfile)
build_native_addon
ADDON_SOURCE="$NATIVE_SRC_DIR/build/Release/doris_lite_embed.node"
[ -f "$ADDON_SOURCE" ] || { echo "ERROR: addon not found: $ADDON_SOURCE" >&2; exit 1; }
mkdir -p "$DIR/native"
cp "$ADDON_SOURCE" "$DIR/native/doris_lite_embed.node"

echo "==> native outputs"
echo "    addon: $DIR/native/doris_lite_embed.node"
echo "    lib:   $DORIS_DIR/lib/native/libdoris_lite.$LIB_EXT"

echo "==> downloading extra Prisma query engines declared in schema"
ENGINES_DIR="$(find "$REPO/node_modules/.pnpm" -maxdepth 4 -type d \
  -path '*@prisma+engines@6*/node_modules/@prisma/engines' | head -n1)"
if [ -n "$ENGINES_DIR" ]; then
  EXTRA_BINARY_TARGETS=$(grep -oE '"(debian|rhel|linux-arm|linux-musl)[^"]*"' "$REPO/packages/shared/prisma/schema.prisma" | tr -d '"' | tr '\n' ',' | sed 's/,$//')
  if [ -n "$EXTRA_BINARY_TARGETS" ]; then
    rm -f "$ENGINES_DIR/download-lock"
    echo "    targets: $EXTRA_BINARY_TARGETS"
    PRISMA_CLI_BINARY_TARGETS="$EXTRA_BINARY_TARGETS" node "$ENGINES_DIR/scripts/postinstall.js" 2>&1 || true
    echo "    engines: $(ls "$ENGINES_DIR"/libquery_engine-* 2>/dev/null | xargs -n1 basename | tr '\n' ' ')"
  fi
fi

# turbo build contains prisma generate dependency
(cd "$REPO" && NODE_OPTIONS='--max-old-space-size-percentage=75' pnpm exec turbo run build --filter=web...)

echo "==> syncing all engines into .prisma/client"
PRISMA_CLIENT_DIR="$(find "$REPO/node_modules/.pnpm" -maxdepth 8 -type d \
  -path '*@prisma+client*/node_modules/.prisma/client' | head -n1)"
if [ -n "$ENGINES_DIR" ] && [ -n "$PRISMA_CLIENT_DIR" ]; then
  cp "$ENGINES_DIR"/libquery_engine-* "$PRISMA_CLIENT_DIR"/
  echo "    client engines: $(ls "$PRISMA_CLIENT_DIR"/libquery_engine-* 2>/dev/null | xargs -n1 basename | tr '\n' ' ')"
fi

STANDALONE="$REPO/web/.next/standalone"
ST="$REPO/web/.next/static"

if [ -f "$STANDALONE/web/server.js" ]; then
  APP_SRC="$STANDALONE"
  WEB_SRC="$STANDALONE/web"
else
  REPO_NAME="$(basename "$REPO")"
  APP_SRC="$STANDALONE/$REPO_NAME"
  WEB_SRC="$APP_SRC/web"
fi

[ -f "$WEB_SRC/server.js" ] || {
  echo "ERROR: $WEB_SRC/server.js not found — is output:'standalone' set?" >&2
  exit 1
}

echo "==> refreshing app bundle in $DIR/app"
mkdir -p "$DIR/app"
rm -rf "$DIR/app/web" "$DIR/app/node_modules" "$DIR/app/packages" "$DIR/app/ee"
cp -R "$APP_SRC"/* "$DIR/app/"

if [ -d "$STANDALONE/node_modules" ]; then
  mkdir -p "$DIR/app/node_modules"
  cp -R "$STANDALONE/node_modules/." "$DIR/app/node_modules/"
fi

if [ ! -e "$DIR/app/node_modules/mysql2" ]; then
  MYSQL2_PNPM_DIR="$(find "$DIR/app/node_modules/.pnpm" -maxdepth 1 -type d -name 'mysql2@*' | sort | tail -n 1)"
  if [ -n "$MYSQL2_PNPM_DIR" ]; then
    ln -s "${MYSQL2_PNPM_DIR#"$DIR/app/node_modules/"}"/node_modules/mysql2 "$DIR/app/node_modules/mysql2"
  fi
fi

rm -rf "$DIR/app/web/.next/static"
cp -R "$ST" "$DIR/app/web/.next/static" # standalone omits static; add it back

echo "==> bundling Prisma query engines into the standalone app"
PRISMA_SRC="$(find "$REPO/node_modules/.pnpm" -maxdepth 8 -type d \
  -path '*@prisma+client*/node_modules/.prisma/client' | head -n1)"
PRISMA_DST="$(find "$DIR/app/node_modules/.pnpm" -maxdepth 8 -type d \
  -path '*@prisma+client*/node_modules/.prisma/client' | head -n1)"
if [ -n "$PRISMA_SRC" ] && [ -n "$PRISMA_DST" ]; then
  cp "$PRISMA_SRC"/libquery_engine-* "$PRISMA_DST"/
  echo "    engines: $(ls "$PRISMA_DST"/libquery_engine-* | xargs -n1 basename | tr '\n' ' ')"
else
  echo "WARN: could not locate .prisma/client engine dir; check binaryTargets" >&2
fi

echo "==> syncing launch scripts to $DIR/bin"
mkdir -p "$DIR/bin"
if [ ! -x "$DIR/bin/node" ]; then
  NODE_VER="$(node -v)"  # e.g. v24.6.0
  TARBALL="node-${NODE_VER}-${HOST_OS}-${HOST_ARCH}.tar.${NODE_ARCHIVE_EXT##tar.}"
  URL="https://nodejs.org/dist/${NODE_VER}/${TARBALL}"
  echo "==> downloading official Node.js ${NODE_VER} (${HOST_OS}-${HOST_ARCH}) into $DIR/bin/node"
  TMP_TAR="$(mktemp)"
  curl -fSL --retry 3 -o "$TMP_TAR" "$URL"
  TMP_DIR="$(mktemp -d)"
  if [ "$NODE_ARCHIVE_EXT" = "tar.xz" ]; then
    tar -xJf "$TMP_TAR" -C "$TMP_DIR"
  else
    tar -xzf "$TMP_TAR" -C "$TMP_DIR"
  fi
  cp "$TMP_DIR/node-${NODE_VER}-${HOST_OS}-${HOST_ARCH}/bin/node" "$DIR/bin/node"
  chmod +x "$DIR/bin/node"
  rm -rf "$TMP_TAR" "$TMP_DIR"
fi
cp "$HERE/start.cjs" "$DIR/bin/start.cjs"
cp "$HERE/start.sh" "$DIR/bin/start.sh"
cp "$HERE/stop.sh" "$DIR/bin/stop.sh"
cp "$HERE/doris-migrations.cjs" "$DIR/bin/doris-migrations.cjs"
chmod +x "$DIR/bin/start.sh" "$DIR/bin/stop.sh"

echo "==> bundling Prisma migrations + cleanup for embedded PG migrations"
mkdir -p "$DIR/app/packages/shared/prisma"
rm -rf "$DIR/app/packages/shared/prisma/migrations"
cp -R "$REPO/packages/shared/prisma/migrations" "$DIR/app/packages/shared/prisma/migrations"
mkdir -p "$DIR/app/packages/shared/scripts"
cp "$REPO/packages/shared/scripts/cleanup.sql" "$DIR/app/packages/shared/scripts/cleanup.sql"

echo "==> syncing standalone Doris assets into app/packages/shared"
mkdir -p "$DIR/app/packages/shared/doris"
rm -rf "$DIR/app/packages/shared/doris/migrations" "$DIR/app/packages/shared/doris/scripts"
cp -R "$REPO/packages/shared/doris/migrations" "$DIR/app/packages/shared/doris/migrations"
cp -R "$REPO/packages/shared/doris/scripts" "$DIR/app/packages/shared/doris/scripts"
rm -rf "$DIR/doris/migrations" "$DIR/doris/scripts"

echo "==> syncing release package.json"
cp "$HERE/package.release.json" "$DIR/package.json"

pack_release
echo "done. release dir: $DIR"
