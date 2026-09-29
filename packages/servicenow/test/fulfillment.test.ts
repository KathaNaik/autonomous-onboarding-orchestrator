import { describe, expect, it } from "vitest";
import * as pkg from "../src/index.js";
import { checkFulfillerAccess, fulfillerRoleFor } from "../src/index.js";
import { loadFulfillerConfig } from "../src/fulfiller-verification.js";

const TABLE = "x_2230066_autono_0_onboarding_access_request";
const ROLE = "x_2230066_autono_0.fulfillment_agent";
const acl = (operation: string, name: string, roles: string[], active = true) => ({
  operation,
  name,
  roles,
  active,
});
const good = {
  acls: [
    acl("read", TABLE, [ROLE, "x_2230066_autono_0.integration_reader"]),
    acl("read", `${TABLE}.*`, [ROLE, "x_2230066_autono_0.integration_reader"]),
    acl("create", TABLE, ["x_2230066_autono_0.integration_writer"]),
    acl("write", TABLE, [ROLE]),
    acl("write", `${TABLE}.fulfillment_state`, [ROLE]),
    acl("write", `${TABLE}.*`, ["admin"]),
  ],
};

describe("fulfiller role least privilege (M7D)", () => {
  it("derives the scoped role name from the table", () => {
    expect(fulfillerRoleFor(TABLE)).toBe(ROLE);
  });

  it("accepts read + table write + fulfillment_state write, guarded by a restrictive wildcard", () => {
    expect(checkFulfillerAccess(TABLE, good)).toEqual([]);
  });

  it("treats a work_notes write grant as unexpected (unsupported in M7D)", () => {
    const withNotes = { acls: [...good.acls, acl("write", `${TABLE}.work_notes`, [ROLE])] };
    expect(checkFulfillerAccess(TABLE, withNotes)).toEqual([
      `${ROLE} is granted write on ${TABLE}.work_notes`,
    ]);
  });

  it("flags missing grants, delete, wildcard write and writes to identity fields", () => {
    const bad = {
      acls: [
        acl("read", TABLE, [ROLE]),
        acl("write", `${TABLE}.*`, [ROLE]),
        acl("write", `${TABLE}.correlation_key`, [ROLE]),
        acl("write", `${TABLE}.approval_state`, [ROLE]),
        acl("delete", TABLE, [ROLE]),
        acl("write", `${TABLE}.fulfillment_state`, [ROLE], false),
      ],
    };
    expect(checkFulfillerAccess(TABLE, bad)).toEqual([
      `no active read ACL on ${TABLE}.* for ${ROLE}`,
      `no active table-level write ACL on ${TABLE} for ${ROLE}`,
      `no active write ACL on ${TABLE}.fulfillment_state for ${ROLE}`,
      `${ROLE} is granted write on every field (${TABLE}.*)`,
      `${ROLE} is granted write on ${TABLE}.correlation_key`,
      `${ROLE} is granted write on ${TABLE}.approval_state`,
      `${ROLE} is granted delete on ${TABLE}`,
    ]);
    const noWildcard = {
      acls: good.acls.filter((a) => !(a.operation === "write" && a.name === `${TABLE}.*`)),
    };
    expect(checkFulfillerAccess(TABLE, noWildcard)).toEqual([
      `no restrictive write ACL on ${TABLE}.* (other fields would be writable)`,
    ]);
  });

  it("keeps the synthetic fulfiller's credentials out of the runtime package", () => {
    expect(Object.keys(pkg)).not.toContain("loadFulfillerConfig");
    expect(() =>
      loadFulfillerConfig({
        SERVICENOW_INSTANCE_URL: "https://dev000000.service-now.com",
        SERVICENOW_USERNAME: "u",
        SERVICENOW_PASSWORD: "p",
        SERVICENOW_ACCESS_REQUEST_TABLE: TABLE,
      }),
    ).toThrow(/SERVICENOW_FULFILLER_USERNAME/);
  });
});

describe("fulfiller table-level gates are limited to fulfillment records", () => {
  it("requires request_kind=fulfillment conditions on the table read/write ACLs", () => {
    const withConditions = (read: string, write: string) => ({
      acls: good.acls.map((a) =>
        a.name === TABLE && a.operation === "read" && a.roles.includes(ROLE)
          ? { ...a, condition: read }
          : a.name === TABLE && a.operation === "write"
            ? { ...a, condition: write }
            : a,
      ),
    });
    expect(
      checkFulfillerAccess(
        TABLE,
        withConditions("request_kind=fulfillment^EQ", "request_kind=fulfillment^EQ"),
      ),
    ).toEqual([]);
    expect(checkFulfillerAccess(TABLE, withConditions("", "request_kind=approval^EQ"))).toEqual([
      `read ACL on ${TABLE} for ${ROLE} isn't limited to request_kind=fulfillment`,
      `write ACL on ${TABLE} for ${ROLE} isn't limited to request_kind=fulfillment`,
    ]);
  });
});
