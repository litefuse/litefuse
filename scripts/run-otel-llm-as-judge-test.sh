#!/bin/bash
set -e

# ============================================================================
# OTel Ingestion Test Script for LLM-as-a-Judge
# ============================================================================
# Usage:
#   ./run-otel-llm-as-judge-test.sh \
#     --url "http://127.0.0.1:3000" \
#     --public-key "pk-lf-xxx" \
#     --secret-key "sk-lf-xxx"
# ============================================================================

# Parse arguments
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

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'
log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# Check required
if [ -z "$URL" ] || [ -z "$PUBLIC_KEY" ] || [ -z "$SECRET_KEY" ]; then
    log_error "Missing required parameters!"
    echo "Usage: $0 --url URL --public-key KEY --secret-key KEY"
    exit 1
fi

log_info "Starting OTel LLM-as-a-Judge test"
log_info "  URL: $URL"
log_info "  Public Key: ${PUBLIC_KEY:0:20}..."

# Create temp file for JSON payload
TEMP_JSON=$(mktemp)

# Use Python to generate valid OTel JSON
# Python outputs trace IDs to stderr, JSON to stdout
PYOUTPUT=$(python3 << PYEOF
import subprocess
import json
import os
import sys

trace_id = subprocess.check_output(['openssl', 'rand', '-hex', '16']).decode().strip()
span_id = subprocess.check_output(['openssl', 'rand', '-hex', '8']).decode().strip()
parent_span_id = subprocess.check_output(['openssl', 'rand', '-hex', '8']).decode().strip()

def hex_to_decimal_array(hex_str):
    return [int(hex_str[i:i+2], 16) for i in range(0, len(hex_str), 2)]

payload = {
    "resourceSpans": [{
        "resource": {
            "attributes": [
                {"key": "telemetry.sdk.language", "value": {"stringValue": "python"}},
                {"key": "telemetry.sdk.name", "value": {"stringValue": "opentelemetry"}},
                {"key": "telemetry.sdk.version", "value": {"stringValue": "1.32.0"}},
                {"key": "langfuse.environment", "value": {"stringValue": "production"}},
                {"key": "service.name", "value": {"stringValue": "llm-as-judge-test"}}
            ]
        },
        "scopeSpans": [{
            "scope": {
                "name": "langfuse-sdk",
                "version": "3.0.0",
                "attributes": [
                    {"key": "public_key", "value": {"stringValue": os.environ.get('PUBLIC_KEY', '')}}
                ]
            },
            "spans": [{
                "traceId": {"type": "Buffer", "data": hex_to_decimal_array(trace_id)},
                "spanId": {"type": "Buffer", "data": hex_to_decimal_array(span_id)},
                "parentSpanId": {"type": "Buffer", "data": hex_to_decimal_array(parent_span_id)},
                "name": "test-generation",
                "kind": 1,
                "startTimeUnixNano": "1714488530686000000",
                "endTimeUnixNano": "1714488530687000000",
                "attributes": [
                    {"key": "gen_ai.operation.name", "value": {"stringValue": "chat"}},
                    {"key": "gen_ai.response.model", "value": {"stringValue": "gpt-4"}},
                    {"key": "gen_ai.input.messages", "value": {"stringValue": json.dumps([{"role": "user", "content": "What is the capital of France? Answer in one word."}])}},
                    {"key": "gen_ai.output.messages", "value": {"stringValue": json.dumps([{"role": "assistant", "content": "Paris."}])}},
                    {"key": "gen_ai.usage.input_tokens", "value": {"intValue": {"low": 100, "high": 0, "unsigned": False}}},
                    {"key": "gen_ai.usage.output_tokens", "value": {"intValue": {"low": 50, "high": 0, "unsigned": False}}},
                    {"key": "gen_ai.request.temperature", "value": {"doubleValue": 0.7}},
                    {"key": "langfuse.trace.name", "value": {"stringValue": "test-trace-for-llm-judge"}},
                    {"key": "langfuse.observation.type", "value": {"stringValue": "generation"}},
                    {"key": "langfuse.observation.prompt.name", "value": {"stringValue": "test-prompt"}},
                    {"key": "langfuse.observation.prompt.version", "value": {"intValue": {"low": 1, "high": 0, "unsigned": False}}}
                ],
                "status": {"code": 1}
            }]
        }]
    }]
}

print(f"TRACE_ID={trace_id}", file=sys.stderr)
print(f"SPAN_ID={span_id}", file=sys.stderr)

json.dump(payload, sys.stdout)
PYEOF
)

# Extract trace IDs from stderr and JSON from stdout
TRACE_ID=$(echo "$PYOUTPUT" | grep "TRACE_ID=" | cut -d= -f2)
SPAN_ID=$(echo "$PYOUTPUT" | grep "SPAN_ID=" | cut -d= -f2)
JSON_BODY=$(echo "$PYOUTPUT" | grep -v "TRACE_ID=" | grep -v "SPAN_ID=")

# Write JSON to temp file
echo "$JSON_BODY" > "$TEMP_JSON"

log_info "Generated Trace ID: $TRACE_ID"
log_info "Generated Span ID: $SPAN_ID"

# Verify JSON is valid
python3 -c "import json; json.load(open('$TEMP_JSON'))" 2>/dev/null || {
    log_error "Generated JSON is invalid"
    cat "$TEMP_JSON"
    rm -f "$TEMP_JSON"
    exit 1
}

# Create Basic Auth header
AUTH_CREDS="${PUBLIC_KEY}:${SECRET_KEY}"
AUTH_BASE64=$(echo -n "$AUTH_CREDS" | base64)

log_info "Sending OTel trace data to ingestion endpoint..."

# Send request
HTTP_RESPONSE=$(curl -s -w "\n%{http_code}" \
  -X POST \
  -H "Content-Type: application/json" \
  -H "x-langfuse-sdk-name: langfuse" \
  -H "x-langfuse-sdk-version: 3.0.0" \
  -H "x-langfuse-ingestion-version: 3" \
  -H "Authorization: Basic ${AUTH_BASE64}" \
  -d @"$TEMP_JSON" \
  "${URL}/api/public/otel/v1/traces")

# Cleanup
rm -f "$TEMP_JSON"

# Parse response
HTTP_CODE=$(echo "$HTTP_RESPONSE" | tail -n1)
BODY=$(echo "$HTTP_RESPONSE" | sed '$d')

log_info "HTTP Response Code: $HTTP_CODE"

if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "207" ]; then
    log_info "OTel data ingested successfully!"
    log_info "Trace ID: $TRACE_ID"
    log_info "Span ID: $SPAN_ID"
    log_warn "Check Langfuse UI for observation under this trace to see if LLM-as-a-Judge was triggered."
    log_warn "Note: LLM-as-a-Judge requires an active evaluator configuration in your project."
else
    log_error "Failed to ingest OTel data. HTTP Code: $HTTP_CODE"
    log_error "Response: $BODY"
    exit 1
fi