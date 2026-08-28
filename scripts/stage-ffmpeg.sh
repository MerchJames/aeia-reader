#!/usr/bin/env bash
# Stage a full ffmpeg into ~/.cache/aura-ffmpeg without root.
#
# Only needed to turn recorded clips into .gif/.mp4 (see scripts/record-tour.ts).
# Playwright ships an ffmpeg, but it is a recording-only build: no GIF encoder,
# no libx264, not even the `fps` filter. This is the same trick as
# stage-browser-libs.sh — apt-get download + dpkg -x into a user-owned dir — so
# it works on a WSL box where you cannot install packages.
#
# Idempotent. Safe to re-run. Does nothing useful on non-apt systems; install
# ffmpeg however your OS prefers instead.
set -u
command -v apt-get >/dev/null || { echo "not an apt system — install ffmpeg yourself"; exit 0; }

DEST="$HOME/.cache/aura-ffmpeg"
ROOT="$DEST/root"
[ -x "$ROOT/usr/bin/ffmpeg" ] && { echo "already staged: $ROOT/usr/bin/ffmpeg"; exit 0; }
mkdir -p "$DEST/debs" && cd "$DEST/debs" || exit 1

echo "Downloading ffmpeg and its runtime dependencies…"
# The dependency closure, plus the handful whose package names cannot be derived
# from their soname (t64 renames, -gnutls variants, BLAS/LAPACK for libavfilter).
PKGS="$(apt-cache depends --recurse --no-recommends --no-suggests --no-conflicts \
  --no-breaks --no-replaces --no-enhances ffmpeg 2>/dev/null \
  | grep '^[a-z]' | sort -u | head -200)"
EXTRA="ffmpeg libsphinxbase3t64 libpocketsphinx3 libvidstab1.1 ocl-icd-libopencl1
  libsrt1.5-gnutls libtheora0 libpulse0 libblas3 liblapack3 libgfortran5 libusb-1.0-0"
apt-get download $PKGS $EXTRA >/dev/null 2>&1

echo "Extracting…"
for d in *.deb; do dpkg -x "$d" "$ROOT" 2>/dev/null; done

LIB="$ROOT/usr/lib/x86_64-linux-gnu"
export LD_LIBRARY_PATH="$LIB:$LIB/pulseaudio:$LIB/blas:$LIB/lapack"
if "$ROOT/usr/bin/ffmpeg" -hide_banner -version >/dev/null 2>&1; then
  echo "OK — $("$ROOT/usr/bin/ffmpeg" -hide_banner -version | head -1)"
  echo "record-tour.ts will find it automatically."
else
  MISSING="$("$ROOT/usr/bin/ffmpeg" -version 2>&1 | grep -oP '\S+\.so[.0-9]*(?=: cannot)' | head -1)"
  echo "Still missing: ${MISSING:-unknown}"
  echo "Download the package that provides it into $DEST/debs and re-run."
  exit 1
fi
