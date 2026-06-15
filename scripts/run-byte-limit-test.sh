#!/bin/bash
set -e

URL=""
PUBLIC_KEY=""
SECRET_KEY=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --url) URL="$2"; shift 2 ;;
        --public-key) PUBLIC_KEY="$2"; shift 2 ;;
        --secret-key) SECRET_KEY="$2"; shift 2 ;;
        *) echo "Unknown option: $1"; exit 1 ;;
    esac
done

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'
log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

if [ -z "$URL" ] || [ -z "$PUBLIC_KEY" ] || [ -z "$SECRET_KEY" ]; then
    log_error "Missing required parameters!"
    echo "Usage: $0 --url URL --public-key KEY --secret-key KEY"
    exit 1
fi

log_info "=== DorisWriter Byte-Size Flush E2E Test ==="
log_info "  URL: $URL"
log_info "  Sending ~200MB of trace data via Langfuse SDK..."
log_info ""
log_info "  Each trace: 256KB input"
log_info "  Batch size: 10 traces per flush (~2.5MB/batch)"
log_info "  Total: 80 batches = 800 traces = ~200MB"
log_info "  Timer flush: 60s (room for byte-size flush to trigger)"
log_info ""

TEMP_DIR=$(mktemp -d)
TEMP_SCRIPT="$TEMP_DIR/test.mjs"

cat > "$TEMP_SCRIPT" << 'NODEEOF'
import { Langfuse } from "langfuse";

const url = process.env.LANGFUSE_URL;
const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
const secretKey = process.env.LANGFUSE_SECRET_KEY;

const INPUT_SIZE = 256 * 1024; // 256KB per trace
const BIG_INPUT = "x".repeat(INPUT_SIZE);
const BATCH_SIZE = 10;        // ~2.5MB per HTTP batch (under SDK limit)
const TOTAL_BATCHES = 80;     // 80 * 10 * 256KB = 200MB

const langfuse = new Langfuse({
  baseUrl: url,
  publicKey: publicKey,
  secretKey: secretKey,
  flushAt: 9999,              // don't auto-flush, we flush manually
  flushInterval: 600_000,     // don't auto-flush on interval
});

console.log(`Starting test: ${TOTAL_BATCHES} batches of ${BATCH_SIZE} traces`);
console.log(`Each trace has ${INPUT_SIZE / 1024}KB input`);
console.log(`Total: ~${(TOTAL_BATCHES * BATCH_SIZE * INPUT_SIZE / 1024 / 1024).toFixed(0)} MB`);
console.log(`Expected: byte-size flush triggers at ~90MB / 256KB ≈ 350 traces`);
console.log("");

const startTime = Date.now();

for (let b = 0; b < TOTAL_BATCHES; b++) {
  const batchLabel = `batch-${String(b).padStart(2, "0")}`;
  for (let i = 0; i < BATCH_SIZE; i++) {
    langfuse.trace({
      name: `byte-limit-${batchLabel}`,
      input: BIG_INPUT,
      metadata: { batch: batchLabel, index: i },
    });
  }
  await langfuse.flushAsync();
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  if ((b + 1) % 10 === 0 || b === 0) {
    console.log(`[${String(b + 1).padStart(2)}/${TOTAL_BATCHES}] Flushed ${BATCH_SIZE} traces (${elapsed}s)`);
  }
}

await langfuse.shutdownAsync();

const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
console.log(`\nDone! ${TOTAL_BATCHES * BATCH_SIZE} traces sent in ${totalTime}s`);
console.log("\nCheck worker logs for byte-size flush:");
console.log("  docker logs langfuse-doris-worker --tail 100 | grep -E 'max.queue.size|hit max'");
NODEEOF

log_info "Installing Langfuse SDK..."
cd "$TEMP_DIR"
npm init -y > /dev/null 2>&1
env -u HTTP_PROXY -u HTTPS_PROXY -u http_proxy -u https_proxy -u ALL_PROXY -u all_proxy \
    npm install --registry=https://registry.npmjs.org/ langfuse > /dev/null 2>&1

log_info "Running test..."
OUTPUT=$(
  LANGFUSE_URL="$URL" \
  LANGFUSE_PUBLIC_KEY="$PUBLIC_KEY" \
  LANGFUSE_SECRET_KEY="$SECRET_KEY" \
  node "$TEMP_SCRIPT"
)

TEST_EXIT=$?

rm -rf "$TEMP_DIR"

if [ $TEST_EXIT -ne 0 ]; then
    log_error "Test failed with exit code: $TEST_EXIT"
    exit $TEST_EXIT
fi

echo "$OUTPUT"
log_info ""
log_info "Test completed. Now check worker logs:"
log_info "  docker logs langfuse-doris-worker --tail 100 | grep -E 'max.queue.size|byte|hit.max|Flushing'"
