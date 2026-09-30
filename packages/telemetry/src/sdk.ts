import { diag, DiagLogLevel } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchSpanProcessor,
  NodeTracerProvider,
  type SpanExporter,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { z } from "zod";

/**
 * Opt-in OpenTelemetry SDK for the API and worker processes. Disabled unless OTEL_ENABLED=true.
 * Spans are exported in the background (batch processor): an unreachable collector or a failed
 * export never blocks or fails business work; exporter errors are swallowed (diag level NONE).
 */
const blankAsUnset = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

export const TelemetryEnvSchema = z.object({
  OTEL_ENABLED: z
    .preprocess(blankAsUnset, z.enum(["true", "false"]).default("false"))
    .transform((v) => v === "true"),
  OTEL_SERVICE_NAME: z.preprocess(blankAsUnset, z.string().trim().min(1).max(100).optional()),
  /** OTLP/HTTP base URL (the exporter appends /v1/traces), e.g. http://otel-collector:4318. */
  OTEL_EXPORTER_OTLP_ENDPOINT: z.preprocess(
    blankAsUnset,
    z
      .url({ protocol: /^https?$/ })
      .transform((u) => u.replace(/\/+$/, ""))
      .optional(),
  ),
});
export type TelemetryEnv = z.infer<typeof TelemetryEnvSchema>;

/** Reads the telemetry settings. Errors name the variable, never its value. */
export function loadTelemetryEnv(
  env: Record<string, string | undefined> = process.env,
): TelemetryEnv {
  const parsed = TelemetryEnvSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(
      `invalid telemetry configuration: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`,
    );
  }
  return parsed.data;
}

export interface TelemetryHandle {
  readonly enabled: boolean;
  shutdown(): Promise<void>;
}

const DISABLED: TelemetryHandle = Object.freeze({ enabled: false, shutdown: async () => {} });

/**
 * Starts tracing for one process (global registration: call once, at startup). Returns a no-op
 * handle when disabled. `processors` replaces the OTLP exporter (tests use an in-memory one).
 */
export function startTelemetry(options: {
  enabled: boolean;
  serviceName: string;
  endpoint?: string | undefined;
  processors?: SpanProcessor[];
  exporter?: SpanExporter;
}): TelemetryHandle {
  if (!options.enabled) return DISABLED;
  diag.setLogger({ error() {}, warn() {}, info() {}, debug() {}, verbose() {} }, DiagLogLevel.NONE);
  const exporter =
    options.exporter ??
    new OTLPTraceExporter({
      url: `${options.endpoint ?? "http://localhost:4318"}/v1/traces`,
      timeoutMillis: 5_000,
    });
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: options.serviceName }),
    spanProcessors: options.processors ?? [new BatchSpanProcessor(exporter)],
  });
  provider.register();
  return {
    enabled: true,
    async shutdown() {
      // Bounded: shutdown never hangs process exit on an unreachable collector.
      await Promise.race([
        provider.shutdown().catch(() => {}),
        new Promise((r) => setTimeout(r, 3_000).unref()),
      ]);
    },
  };
}
