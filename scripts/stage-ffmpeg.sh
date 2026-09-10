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
# Presence is not capability: a half-staged tree has the binary and cannot encode.
if [ -x "$ROOT/usr/bin/ffmpeg" ]; then
  L="$ROOT/usr/lib/x86_64-linux-gnu"
  if LD_LIBRARY_PATH="$L:$L/pulseaudio:$L/blas:$L/lapack" "$ROOT/usr/bin/ffmpeg" -hide_banner \
       -f lavfi -i testsrc=size=64x64:rate=10 -t 1 -c:v libx264 -f mp4 -y /dev/null >/dev/null 2>&1; then
    echo "already staged: $ROOT/usr/bin/ffmpeg"; exit 0
  fi
  echo "staged but cannot encode — completing the dependency closure…"
fi
mkdir -p "$DEST/debs" && cd "$DEST/debs" || exit 1

echo "Downloading ffmpeg and its runtime dependencies…"
# The dependency closure, plus the handful whose package names cannot be derived
# from their soname (t64 renames, -gnutls variants, BLAS/LAPACK for libavfilter).
# NOT truncated. `head -200` cut the closure at an arbitrary point, which is
# invisible until use: `ffmpeg -version` links only a fraction of what a real
# transcode does, so the staged build reported OK and then failed on the first
# clip with "libvorbisfile.so.3: cannot open shared object file".
PKGS="$(apt-cache depends --recurse --no-recommends --no-suggests --no-conflicts \
  --no-breaks --no-replaces --no-enhances ffmpeg 2>/dev/null \
  | grep '^[a-z]' | sort -u)"
EXTRA="ffmpeg libsphinxbase3t64 libpocketsphinx3 libvidstab1.1 ocl-icd-libopencl1
  libsrt1.5-gnutls libtheora0 libpulse0 libblas3 liblapack3 libgfortran5 libusb-1.0-0
  libvorbisfile3 libvorbisenc2 libvorbis0a libogg0 libsvtav1enc1d1 libswscale7
  libswresample4 libavcodec60 libavformat60 libavfilter9 libavutil58 libavdevice60
  libpostproc57 libxss1 libxv1 libxinerama1 libxcb-shape0"
apt-get download $PKGS $EXTRA >/dev/null 2>&1

echo "Extracting…"
for d in *.deb; do dpkg -x "$d" "$ROOT" 2>/dev/null; done

LIB="$ROOT/usr/lib/x86_64-linux-gnu"
export LD_LIBRARY_PATH="$LIB:$LIB/pulseaudio:$LIB/blas:$LIB/lapack"
# Probe with a REAL transcode, not `-version`. The whole point of staging this
# is h264 and GIF output, and only an actual encode links the codecs that do it.
PROBE="$DEST/probe.mp4"
if "$ROOT/usr/bin/ffmpeg" -hide_banner -f lavfi -i testsrc=size=64x64:rate=10 -t 1 \
     -c:v libx264 -pix_fmt yuv420p -y "$PROBE" >/dev/null 2>&1; then
  rm -f "$PROBE"
  echo "OK — $("$ROOT/usr/bin/ffmpeg" -hide_banner -version | head -1)"
  echo "record-tour.ts will find it automatically."
else
  MISSING="$("$ROOT/usr/bin/ffmpeg" -hide_banner -f lavfi -i testsrc -t 1 -c:v libx264 \
    -f mp4 /dev/null 2>&1 | grep -oP '\S+\.so[.0-9]*(?=: cannot)' | head -1)"
  echo "Still missing: ${MISSING:-unknown}"
  echo "Download the package that provides it into $DEST/debs and re-run."
  exit 1
fi
