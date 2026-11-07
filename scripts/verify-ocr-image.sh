#!/usr/bin/env bash
# Build the app image and verify tesseract/poppler + fixture OCR inside the container.
# Prep-only — does not push/deploy. Refuses production Railway tags.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
IMAGE="${OCR_VERIFY_IMAGE:-tma361-ocr-verify:local}"

if [[ "${IMAGE}" == *railway* ]]; then
  echo "Refusing Railway-related image name" >&2
  exit 2
fi

echo "== docker build ${IMAGE} =="
docker build -t "$IMAGE" .

echo "== binaries in image =="
docker run --rm "$IMAGE" bash -lc 'tesseract --version | head -1; which pdftoppm pdftotext'

echo "== OCR fixture scan inside image =="
docker run --rm -v "$ROOT/fixtures/ocr:/fixtures:ro" "$IMAGE" bash -lc \
  'tesseract /fixtures/scan-fixture.png stdout -l eng --psm 6'

echo "OCR image verify OK"
