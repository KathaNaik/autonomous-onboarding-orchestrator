import { describe, expect, it } from "vitest";
import { exportedRecordNames, scanExportText, scanUpdateRecords } from "../src/export-scan.js";

const TABLE = "x_2230066_autono_0_onboarding_access_request";

describe("pre-export scan (M7D)", () => {
  it("finds configured secret values, tunnel URLs, auth headers, keys and tokens, reporting counts only", () => {
    const secret = "callback-secret-0123456789abcdef";
    const text = [
      `<value>${secret}</value>`,
      "https://quiet-lab-1234.trycloudflare.com/webhooks/servicenow/fulfillment",
      "Authorization: Basic YWRtaW46c2VjcmV0cGFzc3dvcmQ=",
      "-----BEGIN RSA PRIVATE KEY-----",
      "ghp_" + "a".repeat(36),
    ].join("\n");
    const findings = scanExportText(text, [{ name: "SERVICENOW_CALLBACK_SECRET", value: secret }]);
    expect(Object.fromEntries(findings.map((f) => [f.category, f.count]))).toMatchObject({
      "secret_value:SERVICENOW_CALLBACK_SECRET": 1,
      tunnel_url: 1,
      authorization_header: 1,
      private_key: 1,
      github_token: 1,
    });
    expect(JSON.stringify(findings)).not.toContain(secret);
    expect(
      scanExportText("<script>gs.getProperty('aoo.approval_callback.secret')</script>", []),
    ).toEqual([]);
  });

  it("flags users, role assignments, properties and data rows of the app table", () => {
    const records = [
      { name: `sys_dictionary_${TABLE}_fulfillment_state` },
      { name: `sys_security_acl_${"a".repeat(32)}` },
      { name: `sys_user_${"b".repeat(32)}` },
      { name: `sys_user_has_role_${"c".repeat(32)}` },
      { name: `sys_properties_${"d".repeat(32)}` },
      { name: `${TABLE}_${"e".repeat(32)}` },
    ];
    expect(scanUpdateRecords(records, TABLE)).toEqual([
      { category: "user_record", count: 1 },
      { category: "role_assignment", count: 1 },
      { category: "system_property", count: 1 },
      { category: "data_row", count: 1 },
    ]);
    const xml =
      `<sys_update_xml action="INSERT_OR_UPDATE"><payload><![CDATA[<record><name>${TABLE}</name></record>]]></payload><name>sys_dictionary_${TABLE}_request_kind</name></sys_update_xml>` +
      `<sys_update_xml action="INSERT_OR_UPDATE"><name>sys_script_${"f".repeat(32)}</name><payload><![CDATA[<name>${TABLE}_${"e".repeat(32)}</name>]]></payload></sys_update_xml>`;
    // Payload-internal <name> fields are not record names: no false data rows.
    expect(exportedRecordNames(xml)).toEqual([
      `sys_dictionary_${TABLE}_request_kind`,
      `sys_script_${"f".repeat(32)}`,
    ]);
    expect(
      scanUpdateRecords(
        exportedRecordNames(xml).map((name) => ({ name })),
        TABLE,
      ),
    ).toEqual([]);
  });
});
