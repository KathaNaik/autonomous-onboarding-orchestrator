"use client";

import { useReducer } from "react";
import * as I from "@/components/console/icons";
import { ActorChip, Lifecycle, StatusBadge, cx, styles as c } from "@/components/console/ui";
import {
  APPROVAL_STEP,
  HIRES,
  INITIAL_SIM,
  LAST_STEP,
  NARRATION,
  SIM_STATE,
  TOOLS,
  decisionCell,
  executeCell,
  planTasks,
  simLifecycle,
  simReducer,
  type Profile,
} from "@/lib/landing-simulator";
import styles from "./simulator.module.css";

/**
 * The landing page's interactive example: a synthetic onboarding the visitor steps through.
 * Client state only (lib/landing-simulator.ts): no fetch, no API, no storage.
 */
export function OnboardingSimulator() {
  const [state, dispatch] = useReducer(simReducer, INITIAL_SIM);
  const { profile, step } = state;
  const hire = HIRES[profile];
  const n = NARRATION[step]!;
  const status = SIM_STATE[step]!;

  return (
    <figure className={styles.sim} aria-label="Interactive example onboarding">
      <div className={styles.toolbar}>
        <span className={styles.toolbarLabel}>Try a different hire:</span>
        <div className={styles.segment} role="group" aria-label="Choose the hire">
          {(Object.keys(HIRES) as Profile[]).map((p) => (
            <button
              key={p}
              type="button"
              className={cx(styles.segButton, p === profile && styles.segActive)}
              aria-pressed={p === profile}
              onClick={() => dispatch({ type: "profile", profile: p })}
            >
              {HIRES[p].label}
            </button>
          ))}
        </div>
      </div>

      <div className={styles.head}>
        <div>
          <div className={styles.name}>{hire.name}</div>
          <div className={styles.meta}>{hire.meta}</div>
        </div>
        <StatusBadge tone={status.tone ?? "gray"} label={status.label} />
      </div>

      <div className={styles.lifecycle}>
        <Lifecycle compact steps={simLifecycle(state)} />
      </div>

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <caption className={c.skip}>How each tool is decided</caption>
          <thead>
            <tr>
              <th scope="col">Tool</th>
              <th scope="col">AI suggests</th>
              <th scope="col">Policy decides</th>
              <th scope="col">Swift sets up</th>
            </tr>
          </thead>
          <tbody>
            {TOOLS.map((t) => {
              const decision = decisionCell(state, t.id);
              const execute = executeCell(state, t.id);
              const pending = decision?.label === "Needs approval" && step === APPROVAL_STEP;
              return (
                <tr key={t.id} className={cx(pending && styles.focusRow)}>
                  <th scope="row" className={styles.tool}>
                    {t.name}
                  </th>
                  <td data-label="AI suggests">
                    {step < 1 ? (
                      <span className={c.muted}>—</span>
                    ) : (
                      <span className={styles.conf}>
                        <span className={styles.confTrack} aria-hidden="true">
                          <span className={styles.confFill} style={{ width: `${t.confidence}%` }} />
                        </span>
                        {t.confidence}%
                      </span>
                    )}
                  </td>
                  <td data-label="Policy decides">
                    {decision ? (
                      <span className={styles.cellStack}>
                        <StatusBadge tone={decision.tone ?? "gray"} label={decision.label} />
                        <span className={styles.why}>{decision.why}</span>
                      </span>
                    ) : (
                      <span className={c.muted}>—</span>
                    )}
                  </td>
                  <td data-label="Swift sets up">
                    {execute.tone ? (
                      <StatusBadge tone={execute.tone} label={execute.label} />
                    ) : (
                      <span className={c.muted}>{execute.label}</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {step >= 5 && (
        <ul className={styles.plan} aria-label="First-month plan">
          {planTasks(state).map((task) => (
            <li key={task}>
              <I.Check size={14} /> {task}
            </li>
          ))}
        </ul>
      )}

      <div className={styles.narration} aria-live="polite">
        <div className={styles.narrationHead}>
          <span className={styles.stepCount}>
            Step {step + 1} of {LAST_STEP + 1}
          </span>
          <ActorChip actor={n.actor} label={n.actorLabel} />
        </div>
        <p className={styles.narrationTitle}>{n.title}</p>
        <p className={styles.narrationText}>{n.text}</p>
      </div>

      <div className={styles.controls}>
        <button
          type="button"
          className={cx(c.button, c.ghost)}
          onClick={() => dispatch({ type: "back" })}
          disabled={step === 0}
        >
          Back
        </button>
        <div className={styles.controlsRight}>
          {step === APPROVAL_STEP ? (
            <>
              <button
                type="button"
                className={cx(c.button, c.secondary)}
                onClick={() => dispatch({ type: "decide", approval: "rejected" })}
              >
                Reject
              </button>
              <button
                type="button"
                className={cx(c.button, c.primary)}
                onClick={() => dispatch({ type: "decide", approval: "approved" })}
              >
                Approve in ServiceNow
              </button>
            </>
          ) : step === LAST_STEP ? (
            <button
              type="button"
              className={cx(c.button, c.primary)}
              onClick={() => dispatch({ type: "restart" })}
            >
              Start again
            </button>
          ) : (
            <button
              type="button"
              className={cx(c.button, c.primary)}
              onClick={() => dispatch({ type: "next" })}
            >
              Next step
            </button>
          )}
        </div>
      </div>
    </figure>
  );
}
