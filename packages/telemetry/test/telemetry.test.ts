import { trace } from "@opentelemetry/api";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AOO_ATTR,
  aooAttributes,
  contextFromTraceParent,
  currentTraceContext,
  errorType,
  logTraceFields,
  parseTraceParent,
  parseTraceState,
  scrubTelemetryText,
  traceIdOf,
  withSpan,
} from "../src/index.js";
import { loadTelemetryEnv, startTelemetry } from "../src/sdk.js";
import { startInMemoryTelemetry } from "../src/testing.js";

const TP = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

describe("disabled / no SDK: everything is a safe no-op", () => {
  it("without a registered provider spans are non-recording and carry no context", async () => {
    const out = await withSpan("x", { workflowId: "w" }, async (span) => {
      expect(span.isRecording()).toBe(false);
      return 42;
    });
    expect(out).toBe(42);
    expect(currentTraceContext()).toBeNull();
    expect(logTraceFields()).toEqual({});
  });

  it("OTEL is disabled by default; startTelemetry(disabled) registers nothing", async () => {
    expect(loadTelemetryEnv({})).toMatchObject({ OTEL_ENABLED: false });
    // Compose passes empty strings for unset variables: they mean "unset", not invalid.
    expect(
      loadTelemetryEnv({
        OTEL_ENABLED: "",
        OTEL_SERVICE_NAME: "",
        OTEL_EXPORTER_OTLP_ENDPOINT: "",
      }),
    ).toEqual({ OTEL_ENABLED: false });
    expect(
      loadTelemetryEnv({
        OTEL_ENABLED: "true",
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318/",
      }),
    ).toEqual({ OTEL_ENABLED: true, OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318" });
    const handle = startTelemetry({ enabled: false, serviceName: "t" });
    expect(handle.enabled).toBe(false);
    await handle.shutdown();
    expect(trace.getTracerProvider().getTracer("x").startSpan("y").isRecording()).toBe(false);
  });

  it("config errors name the variable, never the value", () => {
    expect(() => loadTelemetryEnv({ OTEL_ENABLED: "yes-sk-proj-leakyvalue123456" })).toThrow(
      /OTEL_ENABLED/,
    );
    try {
      loadTelemetryEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: "ftp://user:sk-secret@host" });
    } catch (e) {
      expect(String(e)).not.toContain("sk-secret");
    }
  });
});

describe("attributes and sanitization", () => {
  it("only the closed aoo.* key set, no empty values, strings scrubbed and capped", () => {
    const attrs = aooAttributes({
      workflowId: "wf-1",
      provider: "github",
      resourceId: undefined,
      accessRequestId: null,
      deliveryAttempt: 2,
      outcome: "failed with Authorization: Bearer abcdefghijklmnop",
      ...({ password: "hunter2", "http.url": "x" } as object),
    });
    expect(Object.keys(attrs).sort()).toEqual(
      [AOO_ATTR.workflowId, AOO_ATTR.provider, AOO_ATTR.deliveryAttempt, AOO_ATTR.outcome].sort(),
    );
    expect(attrs[AOO_ATTR.outcome]).not.toContain("abcdefghijklmnop");
    expect(
      String(aooAttributes({ outcome: "x".repeat(500) })[AOO_ATTR.outcome]).length,
    ).toBeLessThanOrEqual(201);
  });

  it.each([
    ["sk-proj-abcdefghijklmnopqrstu", "sk-proj-abcdefghijklmnopqrstu"],
    ["ghp_abcdefghijklmnopqrstuvwxyz0123456789", "ghp_abcdefghijklmnopqrstuvwxyz0123456789"],
    ["github_pat_11ABCDEFG0123456789_abcdefghij", "github_pat_11ABCDEFG0123456789_abcdefghij"],
    ["SSWS 00abcdefghijklmnopqrstuvwxyz", "00abcdefghijklmnopqrstuvwxyz"],
    ["Basic YWRtaW46c2VjcmV0cGFzc3dvcmQ=", "YWRtaW46c2VjcmV0cGFzc3dvcmQ="],
    ["https://user:pwsecret@host.example/path?token=abcsecret", "pwsecret"],
    ["https://host.example/path?token=abcsecret", "abcsecret"],
    ["x-hris-signature: sha256=deadbeefdeadbeef", "deadbeefdeadbeef"],
    ["password=hunter2secret", "hunter2secret"],
  ])("scrubs %s", (input, secret) => {
    expect(scrubTelemetryText(`error ${input} end`)).not.toContain(secret);
  });

  it("errorType is a code or class name, never the message", () => {
    expect(errorType(Object.assign(new Error("secret sk-abc"), { code: "BUSY" }))).toBe("BUSY");
    expect(errorType(new TypeError("Bearer xyz"))).toBe("TypeError");
    expect(errorType({ code: "has spaces and sk-secret" })).toBe("Error");
  });
});

describe("W3C trace context (validated; no baggage)", () => {
  it("accepts only well-formed version-00 traceparents with non-zero ids", () => {
    expect(parseTraceParent(TP)).toBe(TP);
    expect(parseTraceParent(TP.toUpperCase())).toBe(TP);
    for (const bad of [
      "",
      "01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      "00-00000000000000000000000000000000-00f067aa0ba902b7-01",
      "00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01",
      `${TP}-extra`,
      "00-xyz",
      42,
    ]) {
      expect(parseTraceParent(bad)).toBeNull();
    }
    expect(traceIdOf(TP)).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(parseTraceState("vendor=abc,other=1")).toBe("vendor=abc,other=1");
    expect(parseTraceState("x".repeat(300))).toBeNull();
    expect(parseTraceState("bad\nvalue")).toBeNull();
  });
});

describe("with an in-memory exporter", () => {
  let otel: ReturnType<typeof startInMemoryTelemetry>;
  beforeAll(() => {
    otel = startInMemoryTelemetry();
  });
  afterAll(() => otel.stop());

  it("records spans with safe attributes, parents on a persisted traceparent, and logs ids", async () => {
    let carried: ReturnType<typeof currentTraceContext> = null;
    let logged: ReturnType<typeof logTraceFields> = {};
    await withSpan("parent", { workflowId: "wf-1" }, async () => {
      carried = currentTraceContext();
      logged = logTraceFields();
    });
    expect(carried!.traceParent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(logged.trace_id).toBe(traceIdOf(carried!.traceParent));
    await withSpan("child", { outboxEventId: "e1" }, async () => {}, {
      parent: contextFromTraceParent(carried!.traceParent),
    });
    const [parent, child] = otel.spans();
    expect(child!.spanContext().traceId).toBe(parent!.spanContext().traceId);
    expect(child!.parentSpanContext?.spanId).toBe(parent!.spanContext().spanId);
  });

  it("an error is recorded as a sanitized type only (no message, no stack, no events)", async () => {
    otel.reset();
    const err = Object.assign(new Error("boom Authorization: Bearer sk-proj-abcdefghijklmnopq"), {
      code: "PROVIDER_UNAVAILABLE",
    });
    await expect(withSpan("failing", {}, async () => Promise.reject(err))).rejects.toBe(err);
    const [span] = otel.spans();
    expect(span!.status).toMatchObject({ code: 2, message: "PROVIDER_UNAVAILABLE" });
    expect(span!.attributes[AOO_ATTR.errorType]).toBe("PROVIDER_UNAVAILABLE");
    expect(span!.events).toEqual([]);
    expect(JSON.stringify({ a: span!.attributes, s: span!.status, n: span!.name })).not.toContain(
      "sk-proj",
    );
  });
});
