// Smoke test: emit a real OTel trace via the SDK's protobuf-over-HTTP
// exporter, targeting the local web /api/public/otel/v1/traces.
//
// Verifies the production OTLP-protobuf path end-to-end. Run from web/:
//   node ../scripts/smoke-otel-sdk.mjs
//
// (web depends on @opentelemetry/sdk-trace-base + exporter-trace-otlp-proto,
//  so node module resolution works when invoked under web/.)
import {
  trace,
  context,
  diag,
  DiagConsoleLogger,
  DiagLogLevel,
} from "@opentelemetry/api";
import {
  BasicTracerProvider,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { Resource } from "@opentelemetry/resources";

// Surface exporter errors at WARN/ERROR (DEBUG dumps every internal span,
// which drowns out anything useful).
diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.WARN);

const AUTH = Buffer.from("pk-lf-1234567890:sk-lf-1234567890").toString(
  "base64",
);

const exporter = new OTLPTraceExporter({
  url: "http://localhost:3000/api/public/otel/v1/traces",
  // Doris group_commit_interval_ms = 10s + processing → endpoint takes
  // ~20s. Default exporter timeout is 10s → silent drop. Bump to 60s.
  timeoutMillis: 60_000,
  headers: {
    Authorization: `Basic ${AUTH}`,
    // SDK headers that gate the direct-write enrichment path in
    // OtelIngestionProcessor.processSpansSync.
    "x-langfuse-sdk-name": "python",
    "x-langfuse-sdk-version": "4.0.0",
    "x-langfuse-ingestion-version": "4",
  },
});

const provider = new BasicTracerProvider({
  resource: new Resource({
    "service.name": "smoke-otel-sdk-svc",
    "service.version": "1.0.0",
    "telemetry.sdk.name": "opentelemetry",
    "telemetry.sdk.language": "nodejs",
    "telemetry.sdk.version": "1.26.0",
  }),
});
provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
provider.register();

const tracer = trace.getTracer("langfuse-sdk", "4.0.0");

const root = tracer.startSpan("smoke-otel-sdk-root", {
  attributes: {
    "user.id": "otel-sdk-user",
    "session.id": "otel-sdk-session",
    "input.value": "hi from sdk",
    "output.value": "hello from sdk",
    "langfuse.tags": ["otel-sdk-smoke"],
  },
});

const traceId = root.spanContext().traceId;
const rootSpanId = root.spanContext().spanId;

const gen = tracer.startSpan(
  "smoke-otel-sdk-gen",
  {
    kind: 3, // CLIENT
    attributes: {
      "gen_ai.system": "openai",
      "gen_ai.request.model": "gpt-4o-mini",
      "gen_ai.usage.input_tokens": 7,
      "gen_ai.usage.output_tokens": 4,
      "input.value": JSON.stringify([
        { role: "user", content: "hi from sdk" },
      ]),
      "output.value": "hello from sdk",
    },
  },
  trace.setSpan(context.active(), root),
);

gen.end();
root.end();

console.log("TRACE_ID=" + traceId);
console.log("ROOT_SPAN_ID=" + rootSpanId);
console.log("GEN_SPAN_ID=" + gen.spanContext().spanId);

await provider.forceFlush();
await provider.shutdown();
console.log("done");
