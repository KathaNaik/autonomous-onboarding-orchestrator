import {
  assertOfferLetterPdf,
  OfferLetterAgentError,
  type OfferLetterAgent,
  type OfferLetterProposal,
} from "@aoo/agents";
import { canonicalJson } from "@aoo/catalog";
import { auditEvents, offerLetterExtractions, type Database } from "@aoo/db";
import {
  OfferLetterExtractionViewSchema,
  StartOnboardingFromOfferRequestSchema,
  type HrisOfferSignedEvent,
  type OfferLetterExtractionView,
  type StartOnboardingFromOfferRequest,
  type StartOnboardingFromOfferResponse,
} from "@aoo/shared";
import { and, eq, sql } from "drizzle-orm";
import { noopLogger, type EventLogger } from "../events/types.js";
import { HrisEventConflictError } from "../errors.js";
import type { HrisIntakeService } from "../hris-intake.js";

export type OfferLetterErrorCode =
  | "EXTRACTION_UNAVAILABLE"
  | "INVALID_DOCUMENT"
  | "EXTRACTION_FAILED"
  | "EXTRACTION_NOT_FOUND"
  | "INVALID_PAYLOAD"
  | "ALREADY_SUBMITTED"
  | "EVENT_CONFLICT"
  | "UPLOAD_LIMIT_REACHED"
  | "ONBOARDING_LIMIT_REACHED";

export class OfferLetterError extends Error {
  constructor(
    readonly code: OfferLetterErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "OfferLetterError";
  }
}

export interface OfferLetterService {
  /** Reads one uploaded PDF with the Offer Letter Extractor and records the proposal (not the file). */
  extract(input: { pdf: Uint8Array; operatorId: string }): Promise<OfferLetterExtractionView>;
  getExtraction(extractionId: string): Promise<OfferLetterExtractionView | null>;
  /**
   * Starts the onboarding from the operator-confirmed fields: the same intake transaction as the
   * signed HRIS webhook (receipt, employee, workflow, outbox), with the operator as audit actor.
   * Idempotent per extraction: the event id is `offer-letter:<extractionId>`.
   */
  submit(input: {
    extractionId: string;
    operatorId: string;
    confirmed: unknown;
  }): Promise<StartOnboardingFromOfferResponse>;
}

export const offerLetterEventId = (extractionId: string) => `offer-letter:${extractionId}`;
/** A stable HRIS-style employee id for an operator-started hire. */
export const offerLetterEmployeeId = (extractionId: string) =>
  `OFFER-${extractionId.replace(/-/g, "").slice(0, 16).toUpperCase()}`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * (M11) Offer-letter intake. The agent only proposes display fields; the operator confirms them
 * and chooses the canonical facts (never the AI); the onboarding then starts through the existing
 * HRIS intake. The PDF is never stored: only its hash, size and the proposal.
 */
export function createOfferLetterService(
  db: Database,
  deps: {
    agent?: OfferLetterAgent;
    intake: HrisIntakeService;
    logger?: EventLogger;
    /** (M12) Model-reaching uploads allowed in any rolling 24 hours; unset = unlimited. */
    limits?: {
      perOperatorPerDay: number;
      totalPerDay: number;
      /** Onboardings one operator may start in any rolling 24 hours; unset = unlimited. */
      startsPerOperatorPerDay?: number;
    };
  },
): OfferLetterService {
  const logger = deps.logger ?? noopLogger;

  // (M12) Every upload that reaches the model is audited (extracted or failed), so the caps also
  // count failed calls. Checked before the model call; concurrent uploads may overshoot by the
  // number in flight.
  const MODEL_EVENTS = sql`event_type IN ('offer_letter.extracted', 'offer_letter.extraction_failed')
    AND occurred_at > clock_timestamp() - interval '24 hours'`;
  async function assertWithinLimits(operatorId: string) {
    if (!deps.limits) return;
    const { rows } = await db.execute<{ mine: number; total: number }>(sql`
      SELECT count(*) FILTER (WHERE actor = ${`hr:${operatorId}`})::int AS mine,
             count(*)::int AS total
      FROM audit_events WHERE ${MODEL_EVENTS}`);
    const { mine = 0, total = 0 } = rows[0] ?? {};
    if (mine >= deps.limits.perOperatorPerDay || total >= deps.limits.totalPerDay) {
      throw new OfferLetterError(
        "UPLOAD_LIMIT_REACHED",
        mine >= deps.limits.perOperatorPerDay
          ? "this account reached its daily offer-letter limit"
          : "the daily offer-letter limit is reached",
      );
    }
  }

  // One reviewer or operator starts a bounded number of onboardings (each one makes sandbox
  // writes). Counted from `offer_letter.submitted`; only a new submission counts, so a retry of
  // the same letter is never refused. Concurrent submits may overshoot by the number in flight.
  async function assertWithinStartLimit(operatorId: string) {
    const limit = deps.limits?.startsPerOperatorPerDay;
    if (limit === undefined) return;
    const { rows } = await db.execute<{ mine: number }>(sql`
      SELECT count(*)::int AS mine FROM audit_events
      WHERE event_type = 'offer_letter.submitted' AND actor = ${`hr:${operatorId}`}
        AND occurred_at > clock_timestamp() - interval '24 hours'`);
    if ((rows[0]?.mine ?? 0) >= limit) {
      throw new OfferLetterError(
        "ONBOARDING_LIMIT_REACHED",
        "this account already started its onboarding for today",
      );
    }
  }

  const view = (row: typeof offerLetterExtractions.$inferSelect): OfferLetterExtractionView =>
    OfferLetterExtractionViewSchema.parse({
      extractionId: row.id,
      status: row.status,
      proposal: row.proposal,
      uploadedBy: row.uploadedBy,
      createdAt: row.createdAt.toISOString(),
      workflowId: row.workflowId,
    });

  return {
    async extract({ pdf, operatorId }) {
      if (!deps.agent) {
        throw new OfferLetterError(
          "EXTRACTION_UNAVAILABLE",
          "offer-letter extraction is not configured",
        );
      }
      // Cheap, deterministic file checks first: an invalid file never counts toward the caps.
      try {
        assertOfferLetterPdf(pdf);
      } catch (err) {
        if (err instanceof OfferLetterAgentError) {
          throw new OfferLetterError("INVALID_DOCUMENT", err.message);
        }
        throw err;
      }
      await assertWithinLimits(operatorId);
      let result;
      try {
        result = await deps.agent.extract({ pdf });
      } catch (err) {
        if (err instanceof OfferLetterAgentError) {
          if (err.category === "INVALID_DOCUMENT") {
            throw new OfferLetterError("INVALID_DOCUMENT", err.message);
          }
          // Metadata only; counted toward the daily caps like a successful extraction.
          await db.insert(auditEvents).values({
            workflowId: null,
            eventType: "offer_letter.extraction_failed",
            actor: `hr:${operatorId}`,
            payload: { category: err.category, attempts: err.attempts },
          });
          logger.warn(
            { category: err.category, attempts: err.attempts },
            "offer letter extraction failed",
          );
          throw new OfferLetterError(
            "EXTRACTION_FAILED",
            `the offer letter could not be read (${err.category})`,
            err.retryable,
          );
        }
        throw err;
      }
      const proposal: OfferLetterProposal = result.proposal;
      const row = await db.transaction(async (tx) => {
        const [inserted] = await tx
          .insert(offerLetterExtractions)
          .values({
            fileSha256: result.fileSha256,
            fileBytes: result.fileBytes,
            uploadedBy: operatorId,
            promptVersion: result.promptVersion,
            modelProvider: result.provider,
            model: result.model,
            modelConfig: result.modelConfig,
            servedModel: result.servedModel ?? null,
            providerResponseId: result.responseId ?? null,
            modelCalls: result.attempts,
            latencyMs: result.latencyMs,
            inputTokens: result.usage?.inputTokens ?? null,
            outputTokens: result.usage?.outputTokens ?? null,
            proposal: { ...proposal },
          })
          .returning();
        // Metadata only: no names, emails or letter content in the audit trail.
        await tx.insert(auditEvents).values({
          workflowId: null,
          eventType: "offer_letter.extracted",
          actor: `hr:${operatorId}`,
          payload: {
            extractionId: inserted!.id,
            fileBytes: result.fileBytes,
            promptVersion: result.promptVersion,
            servedModel: result.servedModel ?? null,
            isOfferLetter: proposal.isOfferLetter,
            warnings: proposal.warnings.length,
          },
        });
        return inserted!;
      });
      logger.info(
        { extractionId: row.id, latencyMs: result.latencyMs, modelCalls: result.attempts },
        "offer letter extracted",
      );
      return view(row);
    },

    async getExtraction(extractionId) {
      if (!UUID.test(extractionId)) return null;
      const [row] = await db
        .select()
        .from(offerLetterExtractions)
        .where(eq(offerLetterExtractions.id, extractionId));
      return row ? view(row) : null;
    },

    async submit({ extractionId, operatorId, confirmed: raw }) {
      const parsed = StartOnboardingFromOfferRequestSchema.safeParse(raw);
      if (!parsed.success) {
        const fields = [...new Set(parsed.error.issues.map((i) => i.path.join(".") || "(body)"))];
        throw new OfferLetterError("INVALID_PAYLOAD", `invalid fields: ${fields.join(", ")}`);
      }
      const confirmed: StartOnboardingFromOfferRequest = parsed.data;
      if (!UUID.test(extractionId)) {
        throw new OfferLetterError("EXTRACTION_NOT_FOUND", "offer letter not found");
      }
      const [row] = await db
        .select()
        .from(offerLetterExtractions)
        .where(eq(offerLetterExtractions.id, extractionId));
      if (!row) throw new OfferLetterError("EXTRACTION_NOT_FOUND", "offer letter not found");
      if (row.status === "SUBMITTED" && canonicalJson(row.confirmed) !== canonicalJson(confirmed)) {
        throw new OfferLetterError(
          "ALREADY_SUBMITTED",
          "this offer letter already started an onboarding with different details",
        );
      }

      if (row.status !== "SUBMITTED") await assertWithinStartLimit(operatorId);

      // Deterministic event: a retry (crash, double click) is the same event → a durable duplicate.
      const eventId = offerLetterEventId(extractionId);
      const event: HrisOfferSignedEvent = {
        eventId,
        eventType: "offer.signed",
        occurredAt: row.createdAt.toISOString(),
        employeeId: offerLetterEmployeeId(extractionId),
        employee: {
          firstName: confirmed.firstName,
          lastName: confirmed.lastName,
          email: confirmed.email,
        },
        role: confirmed.role,
        department: confirmed.department,
        ...(confirmed.jobDescription && { jobDescription: confirmed.jobDescription }),
        managerId: confirmed.managerId,
        ...(confirmed.startDate && { startDate: confirmed.startDate }),
        offerStatus: "SIGNED",
        candidateStatus: "CLEARED",
        departmentCode: confirmed.departmentCode,
        roleFamilyCode: confirmed.roleFamilyCode,
        employmentType: confirmed.employmentType,
      };
      let accepted;
      try {
        accepted = await deps.intake.acceptOfferSigned(event, { actor: `hr:${operatorId}` });
      } catch (err) {
        if (err instanceof HrisEventConflictError) {
          throw new OfferLetterError(
            "EVENT_CONFLICT",
            "this offer letter already started an onboarding with different details",
          );
        }
        throw err;
      }
      await db.transaction(async (tx) => {
        const updated = await tx
          .update(offerLetterExtractions)
          .set({
            status: "SUBMITTED",
            confirmed: { ...confirmed },
            submittedBy: operatorId,
            hrisEventId: eventId,
            workflowId: accepted.workflowId,
            submittedAt: sql`clock_timestamp()`,
          })
          .where(
            and(
              eq(offerLetterExtractions.id, extractionId),
              eq(offerLetterExtractions.status, "EXTRACTED"),
            ),
          )
          .returning({ id: offerLetterExtractions.id });
        if (updated.length === 0) return; // already recorded (idempotent retry)
        await tx
          .insert(auditEvents)
          .values({
            workflowId: accepted.workflowId,
            eventType: "offer_letter.submitted",
            actor: `hr:${operatorId}`,
            payload: {
              extractionId,
              hrisEventId: eventId,
              workflowCreated: accepted.workflowCreated,
            },
            idempotencyKey: `offer-letter-submitted:${extractionId}`,
          })
          .onConflictDoNothing();
      });
      logger.info({ extractionId, workflowId: accepted.workflowId }, "offer letter submitted");
      return {
        extractionId,
        eventId,
        workflowId: accepted.workflowId,
        workflowCreated: accepted.workflowCreated,
        duplicate: accepted.duplicate,
      };
    },
  };
}
