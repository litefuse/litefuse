#!/bin/bash
set -e

# ============================================================================
# Prompt-Linked Generation Test Script
# ============================================================================
# Usage:
#   ./run-prompt-linked-test.sh \
#     --url "http://127.0.0.1:3000" \
#     --public-key "pk-lf-xxx" \
#     --secret-key "sk-lf-xxx" \
#     --project-name "gdr-tracebench" \
#     --prompt-name "test_1"
# ============================================================================

# Parse arguments
URL=""
PUBLIC_KEY=""
SECRET_KEY=""
PROJECT_NAME=""
PROMPT_NAME=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --url) URL="$2"; shift 2 ;;
        --public-key) PUBLIC_KEY="$2"; shift 2 ;;
        --secret-key) SECRET_KEY="$2"; shift 2 ;;
        --project-name) PROJECT_NAME="$2"; shift 2 ;;
        --prompt-name) PROMPT_NAME="$2"; shift 2 ;;
        *) echo "Unknown option: $1"; exit 1 ;;
    esac
done

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'
log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# Check required
if [ -z "$URL" ] || [ -z "$PUBLIC_KEY" ] || [ -z "$SECRET_KEY" ] || [ -z "$PROJECT_NAME" ] || [ -z "$PROMPT_NAME" ]; then
    log_error "Missing required parameters!"
    echo "Usage: $0 --url URL --public-key KEY --secret-key KEY --project-name NAME --prompt-name NAME"
    exit 1
fi

log_info "Starting prompt-linked generation test"
log_info "  URL: $URL"
log_info "  Project: $PROJECT_NAME"
log_info "  Prompt: $PROMPT_NAME"

# Create temp directory for test
TEMP_DIR=$(mktemp -d)
TEMP_SCRIPT="$TEMP_DIR/test.mjs"

cat > "$TEMP_SCRIPT" << 'NODEEOF'
import { Langfuse } from "langfuse";

const url = process.env.LANGFUSE_URL;
const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
const secretKey = process.env.LANGFUSE_SECRET_KEY;
const projectName = process.env.PROJECT_NAME;
const promptName = process.env.PROMPT_NAME;

const langfuse = new Langfuse({
  baseUrl: url,
  publicKey: publicKey,
  secretKey: secretKey,
});

async function main() {
  console.log("Connecting to Langfuse at", url);

  // Get project
  const projects = await langfuse.api.projectsGet({});
  const project = projects.data.find(p => p.name === projectName);
  if (!project) {
    console.error("Project not found:", projectName);
    console.log("Available projects:", projects.data.map(p => p.name).join(", "));
    process.exit(1);
  }
  console.log("Project ID:", project.id, "Name:", project.name);

  // Get prompt details
  const prompt = await langfuse.api.promptsGet({
    projectId: project.id,
    promptName: promptName,
  });

  if (!prompt || !prompt.id) {
    console.error("Prompt not found:", promptName);
    process.exit(1);
  }
  console.log("Prompt ID:", prompt.id, "Version:", prompt.version);
  console.log("Prompt content:", JSON.stringify(prompt.prompt).slice(0, 100) + "...");

  // Create trace
  const trace = langfuse.trace({
    name: `test-prompt-link-${Date.now()}`,
    metadata: { source: "test-script" },
    environment: "prompt-experiment",
  });

  // Create generation linked to prompt with proper input/output (chat message format)
  const generation = langfuse.generation({
    traceId: trace.id,
    name: `test-generation-${Date.now()}`,
    prompt: {
      name: promptName,
      version: prompt.version,
    },
    model: "test-model",
    input: [{ role: "user", content: "test input from shell script" }],
    output: "test output from shell script",
    metadata: { source: "test-script", testType: "prompt-linked" },
    environment: "prompt-experiment",
  });

  await langfuse.flushAsync();

  console.log("\n=== Test Results ===");
  console.log("Trace ID:", trace.id);
  console.log("Generation ID:", generation.id);
  console.log("Trace URL:", `${url}/trace/${trace.id}`);
  console.log("\nGeneration successfully linked to prompt:", promptName, "v" + prompt.version);

  await langfuse.shutdownAsync();
}

main().catch(err => {
  console.error("Test FAILED:", err.message);
  process.exit(1);
});
NODEEOF

# Initialize npm project in temp dir and install langfuse
log_info "Installing langfuse SDK..."
cd "$TEMP_DIR"
npm init -y > /dev/null 2>&1
npm install langfuse > /dev/null 2>&1

# Run the script
log_info "Running test..."
LANGFUSE_URL="$URL" \
LANGFUSE_PUBLIC_KEY="$PUBLIC_KEY" \
LANGFUSE_SECRET_KEY="$SECRET_KEY" \
PROJECT_NAME="$PROJECT_NAME" \
PROMPT_NAME="$PROMPT_NAME" \
node "$TEMP_SCRIPT"

TEST_EXIT=$?

# Cleanup
rm -rf "$TEMP_DIR"

if [ $TEST_EXIT -eq 0 ]; then
    log_info "Test completed successfully"
else
    log_error "Test failed with exit code: $TEST_EXIT"
fi

exit $TEST_EXIT