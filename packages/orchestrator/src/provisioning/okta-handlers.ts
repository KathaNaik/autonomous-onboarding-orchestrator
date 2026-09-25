import { createHash } from "node:crypto";
import { OktaError, OktaNewUserSchema, type OktaClient, type OktaUser } from "@aoo/okta";
import { z } from "zod";
import type {
  ExternalOperationHandler,
  FailureClass,
  HandlerProbe,
} from "../external-operations/handler.js";

/** The Okta calls provisioning needs; satisfied by OktaClient (and by test doubles). */
export type OktaGateway = Pick<
  OktaClient,
  | "getUser"
  | "findUsersByExactIdentity"
  | "createUser"
  | "getGroup"
  | "isUserInGroup"
  | "addUserToGroup"
>;

export const OKTA_ENSURE_USER = "okta.ensure_user";
export const OKTA_ADD_GROUP_MEMBERSHIP = "okta.add_group_membership";

const digest = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 40);

/**
 * Identity-level key: one logical "ensure the Okta user" operation per employee, shared by every
 * Okta resource of that employee, so concurrent resources can never create two users.
 */
export function oktaEnsureUserKeys(employeeId: string) {
  const idempotencyKey = `${OKTA_ENSURE_USER}:employee=${employeeId}`;
  return { idempotencyKey, correlationKey: `okta-user:${digest(idempotencyKey)}` };
}

/** Entitlement-level key: one membership operation per authorized access request and target. */
export function oktaMembershipKeys(input: {
  accessDecisionId: string;
  accessRequestId: string;
  groupId: string;
}) {
  const idempotencyKey = `${OKTA_ADD_GROUP_MEMBERSHIP}:decision=${input.accessDecisionId}:request=${input.accessRequestId}:provider=okta:group=${input.groupId}`;
  return { idempotencyKey, correlationKey: `okta-membership:${digest(idempotencyKey)}` };
}

const EnsureUserRequestSchema = z.strictObject({
  employeeId: z.uuid(),
  profile: OktaNewUserSchema,
});
export type EnsureUserRequest = z.infer<typeof EnsureUserRequestSchema>;

const MembershipRequestSchema = z.strictObject({
  accessRequestId: z.uuid(),
  accessDecisionId: z.uuid(),
  resourceId: z.string().min(1),
  oktaUserId: z.string().min(1),
  groupId: z.string().min(1),
  expectedGroupName: z.string().min(1),
});
export type MembershipRequest = z.infer<typeof MembershipRequestSchema>;

/** Identifying attributes that must match exactly; names are display data and not compared. */
export function identityMismatches(
  user: OktaUser,
  profile: EnsureUserRequest["profile"],
): string[] {
  const mismatched: string[] = [];
  if (user.profile.login.toLowerCase() !== profile.login.toLowerCase()) mismatched.push("login");
  if (user.profile.email.toLowerCase() !== profile.email.toLowerCase()) mismatched.push("email");
  if ((user.profile.employeeNumber ?? "") !== profile.employeeNumber)
    mismatched.push("employeeNumber");
  if (user.status === "DEPROVISIONED") mismatched.push("status");
  return mismatched;
}

/** Shared Okta error classification for the durable executor. */
export function classifyOktaError(err: unknown): FailureClass {
  if (!(err instanceof OktaError)) return "retry";
  if (err.notSent) return "not_sent";
  switch (err.code) {
    case "OUTCOME_UNKNOWN":
      return "outcome_unknown";
    case "BAD_REQUEST":
      // E0000001 on create: "an object with this field already exists": the user may have been
      // created by an earlier, uncertain attempt. Reconcile rather than fail.
      return err.oktaErrorCode === "E0000001" ? "outcome_unknown" : "failed";
    case "AUTHENTICATION_FAILED":
    case "PERMISSION_DENIED":
    case "REQUEST_INVALID":
    case "CONFIG_INVALID":
    case "UNEXPECTED_REDIRECT":
      return "failed";
    default:
      return "retry";
  }
}

export function createOktaEnsureUserHandler(
  okta: OktaGateway,
): ExternalOperationHandler<EnsureUserRequest> {
  const probeUser = (user: OktaUser, request: EnsureUserRequest): HandlerProbe => {
    const mismatched = identityMismatches(user, request.profile);
    return mismatched.length === 0
      ? { kind: "satisfied", externalId: user.id, externalReference: user.profile.login }
      : {
          kind: "conflict",
          code: "OKTA_IDENTITY_CONFLICT",
          message: `Okta user conflicts with the authoritative identity in: ${mismatched.join(", ")}`,
          // Field names and ids only: never profile values.
          evidence: { oktaUserId: user.id, mismatchedFields: mismatched },
        };
  };
  return {
    provider: "okta",
    operationType: OKTA_ENSURE_USER,
    parseRequest: (raw) => EnsureUserRequestSchema.parse(raw),
    sensitiveValues: ({ profile }) => [
      profile.login,
      profile.email,
      profile.firstName,
      profile.lastName,
      profile.employeeNumber,
    ],
    async reconcile(request, { signal }) {
      const candidates = await okta.findUsersByExactIdentity(
        { login: request.profile.login, employeeNumber: request.profile.employeeNumber },
        { signal },
      );
      if (candidates.length === 0) return { kind: "absent" };
      if (candidates.length > 1) {
        return {
          kind: "conflict",
          code: "AMBIGUOUS_OKTA_IDENTITY",
          message: `${candidates.length} Okta users match the authoritative identity`,
          evidence: { candidateIds: candidates.map((u) => u.id).sort() },
        };
      }
      return probeUser(candidates[0]!, request);
    },
    perform: (request, { signal }) => okta.createUser(request.profile, { signal }),
    async verify(request, performed, { signal }) {
      const id = (performed as OktaUser).id;
      const readBack = await okta.getUser(id, { signal });
      return readBack ? probeUser(readBack, request) : { kind: "absent" };
    },
    classify: classifyOktaError,
  };
}

export function createOktaMembershipHandler(
  okta: OktaGateway,
): ExternalOperationHandler<MembershipRequest> {
  return {
    provider: "okta",
    operationType: OKTA_ADD_GROUP_MEMBERSHIP,
    parseRequest: (raw) => MembershipRequestSchema.parse(raw),
    sensitiveValues: () => [],
    async reconcile(request, { signal }) {
      // The configured target must exist and be exactly the expected group: never guess.
      const group = await okta.getGroup(request.groupId, { signal });
      if (!group) {
        return {
          kind: "conflict",
          code: "OKTA_GROUP_NOT_FOUND",
          message: "the configured Okta group does not exist",
          evidence: { groupId: request.groupId },
        };
      }
      if (group.profile.name !== request.expectedGroupName || group.type === "BUILT_IN") {
        return {
          kind: "conflict",
          code: "OKTA_GROUP_MISMATCH",
          message: "the configured Okta group is not the expected target",
          evidence: { groupId: request.groupId, type: group.type },
        };
      }
      const user = await okta.getUser(request.oktaUserId, { signal });
      if (!user) {
        return {
          kind: "conflict",
          code: "OKTA_USER_NOT_FOUND",
          message: "the linked Okta user does not exist",
          evidence: { oktaUserId: request.oktaUserId },
        };
      }
      const member = await okta.isUserInGroup(request.oktaUserId, request.groupId, { signal });
      return member
        ? {
            kind: "satisfied",
            externalId: `${request.groupId}/${request.oktaUserId}`,
            externalReference: request.groupId,
          }
        : { kind: "absent" };
    },
    perform: (request, { signal }) =>
      okta.addUserToGroup(request.groupId, request.oktaUserId, { signal }),
    async verify(request, _performed, { signal }) {
      const member = await okta.isUserInGroup(request.oktaUserId, request.groupId, { signal });
      return member
        ? {
            kind: "satisfied",
            externalId: `${request.groupId}/${request.oktaUserId}`,
            externalReference: request.groupId,
          }
        : { kind: "absent" };
    },
    classify: classifyOktaError,
  };
}

/** Both Okta handlers, for ExternalOperationServiceOptions.handlers. */
export function createOktaHandlers(okta: OktaGateway): ExternalOperationHandler[] {
  return [
    createOktaEnsureUserHandler(okta) as ExternalOperationHandler,
    createOktaMembershipHandler(okta) as ExternalOperationHandler,
  ];
}
