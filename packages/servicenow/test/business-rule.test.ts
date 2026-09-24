import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { verifyServiceNowCallback } from "@aoo/webhooks";
import { describe, expect, it } from "vitest";

// Executes the EXACT business-rule script that is pasted into ServiceNow, in a sandbox that
// mimics the scoped ServiceNow globals, and checks its signature against Node's crypto and our
// real verifier. Scoped apps can't use GlideCertificateEncryption, so the script ships its own
// ES5 HMAC-SHA256; this test is what makes that safe.
const script = readFileSync(
  fileURLToPath(
    new URL("../servicenow-app/business-rules/aoo-approval-callback.js", import.meta.url),
  ),
  "utf8",
);

interface Sent {
  url?: string;
  headers: Record<string, string>;
  body?: string;
}

function runRule(opts: {
  secret: string;
  fields: Record<string, string>;
  now?: number;
  status?: number;
}) {
  const sent: Sent = { headers: {} };
  const warnings: string[] = [];
  const props: Record<string, string> = {
    "aoo.approval_callback.url": "https://example.test/webhooks/servicenow/approvals",
    "aoo.approval_callback.secret": opts.secret,
    "aoo.approval_callback.instance": "dev225201",
  };
  const current = {
    getUniqueValue: () => opts.fields.sys_id!,
    getTableName: () => "x_2230066_autono_0_onboarding_access_request",
    getValue: (name: string) => opts.fields[name] ?? "",
  };
  class RESTMessageV2 {
    setEndpoint(u: string) {
      sent.url = u;
    }
    setHttpMethod() {}
    setRequestHeader(k: string, v: string) {
      sent.headers[k.toLowerCase()] = v;
    }
    setRequestBody(b: string) {
      sent.body = b;
    }
    setHttpTimeout() {}
    execute() {
      return { getStatusCode: () => opts.status ?? 202 };
    }
  }
  const context = vm.createContext({
    current,
    previous: null,
    JSON,
    Math,
    String,
    Array,
    gs: { getProperty: (n: string) => props[n] ?? null, warn: (m: string) => warnings.push(m) },
    GlideDateTime: class {
      getNumericValue() {
        return opts.now ?? 1_790_000_000_000;
      }
    },
    sn_ws: { RESTMessageV2 },
    // Deliberately absent, as in a scoped app: GlideCertificateEncryption, GlideStringUtil.
  });
  vm.runInContext(script, context);
  return { sent, warnings };
}

const baseFields = {
  sys_id: "35bf3385c3274310317dfb2ed4013198",
  sys_mod_count: "1",
  number: "OAR0001006",
  correlation_key: "aoo-test-oar-1fb6f302c49e1b3bdb0c3dd829549eef54d0d9ad",
  approval_state: "approved",
};

describe("ServiceNow business rule: AOO approval callback", () => {
  it("sends the minimal identifier payload with a signature our API verifies", () => {
    const secret = "live-like-callback-secret-0123456789abcdefgh";
    const { sent, warnings } = runRule({ secret, fields: baseFields, now: Date.now() });

    expect(warnings).toEqual([]);
    expect(sent.url).toBe("https://example.test/webhooks/servicenow/approvals");
    expect(JSON.parse(sent.body!)).toEqual({
      eventId: `${baseFields.sys_id}:1`,
      instance: "dev225201",
      table: "x_2230066_autono_0_onboarding_access_request",
      sysId: baseFields.sys_id,
      number: baseFields.number,
      correlationKey: baseFields.correlation_key,
      claimedApprovalState: "approved",
    });
    expect(
      verifyServiceNowCallback({
        rawBody: sent.body!,
        timestamp: sent.headers["x-aoo-timestamp"],
        signature: sent.headers["x-aoo-signature"],
        secret,
      }),
    ).toEqual({ ok: true });
  });

  it("its ES5 HMAC-SHA256 matches Node crypto across key lengths, unicode and SHA-256 padding boundaries", () => {
    const secrets = [
      "k",
      "x".repeat(63),
      "y".repeat(64),
      "z".repeat(65),
      "s".repeat(200),
      "ünïcødé-🔑-secret-√",
    ];
    let checked = 0;
    for (const secret of secrets) {
      // Vary the body length byte by byte so messages land on every padding boundary (55/56/64...).
      for (let extra = 0; extra < 70; extra++) {
        const fields = {
          ...baseFields,
          correlation_key: `k${"a".repeat(extra)}`,
          number: extra % 7 ? "OAR1" : "OAR√2",
        };
        const { sent } = runRule({ secret, fields, now: 1_790_000_000_000 + extra });
        const ts = sent.headers["x-aoo-timestamp"]!;
        const expected = createHmac("sha256", secret).update(`${ts}.${sent.body}`).digest("base64");
        expect(sent.headers["x-aoo-signature"]).toBe(`v1=${expected}`);
        checked++;
      }
    }
    expect(checked).toBe(secrets.length * 70);
  });

  it("does nothing (and says so) when the properties are missing", () => {
    const { sent, warnings } = runRule({ secret: "", fields: baseFields });
    expect(sent.body).toBeUndefined();
    expect(warnings[0]).toContain("not configured");
  });

  it("logs only the status on a non-202 response, never the secret or body", () => {
    const secret = "never-log-this-secret-0123456789abcdef";
    const { warnings } = runRule({ secret, fields: baseFields, status: 401 });
    expect(warnings).toEqual(["AOO approval callback for OAR0001006 returned HTTP 401"]);
  });

  it("uses no API that ServiceNow forbids in scoped applications", () => {
    const code = script.slice(script.indexOf("(function executeRule"));
    for (const forbidden of [
      "GlideCertificateEncryption",
      "GlideStringUtil",
      "gs.base64Encode",
      "Packages.",
    ]) {
      expect(code).not.toContain(forbidden);
    }
  });
});
