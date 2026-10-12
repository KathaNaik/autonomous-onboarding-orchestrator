import Link from "next/link";
import type { ReactNode } from "react";
import type { ActorKind, StepStatus, Tone } from "@/lib/console-model";
import * as I from "./icons";
import s from "./console.module.css";

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

// ---- Buttons ------------------------------------------------------------------------------

type Variant = "primary" | "secondary" | "ghost";

export function ButtonLink({
  href,
  variant = "secondary",
  children,
  className,
}: {
  href: string;
  variant?: Variant;
  children: ReactNode;
  className?: string | undefined;
}) {
  return (
    <Link href={href} className={cx(s.button, s[variant], className)}>
      {children}
    </Link>
  );
}

export function Button({
  variant = "primary",
  children,
  block,
}: {
  variant?: Variant;
  children: ReactNode;
  block?: boolean;
}) {
  return (
    <button type="submit" className={cx(s.button, s[variant], block && s.block)}>
      {children}
    </button>
  );
}

// ---- Status -------------------------------------------------------------------------------

const TONE_ICON: Record<Tone, () => ReactNode> = {
  green: () => <I.Check size={12} />,
  amber: () => <I.Clock size={12} />,
  blue: () => <I.Spinner size={12} />,
  red: () => <I.Cross size={12} />,
  gray: () => <I.Dot size={12} />,
};

/** A status badge: always text plus an icon shape, so color is never the only cue. */
export function StatusBadge({
  tone,
  label,
  code,
}: {
  tone: Tone;
  label: string;
  /** The raw state code, kept as a data attribute (tests, tooling), never as visible text. */
  code?: string | null;
}) {
  return (
    <span className={cx(s.badge, s[tone])} data-state={code ?? undefined}>
      {TONE_ICON[tone]()}
      {label}
    </span>
  );
}

const ACTOR_CLASS: Partial<Record<ActorKind, string | undefined>> = {
  AI: s.chipAI,
  Policy: s.chipPolicy,
};
const ACTOR_ICON: Partial<Record<ActorKind, () => ReactNode>> = {
  AI: () => <I.Sparkle size={11} />,
  Policy: () => <I.Shield size={11} />,
  Worker: () => <I.Gear size={11} />,
  HR: () => <I.Person size={11} />,
  Operator: () => <I.Person size={11} />,
};

/** Who did something: HR, AI, Policy, Worker, ServiceNow, GitHub, Okta… */
export function ActorChip({ actor, label }: { actor: ActorKind; label?: string }) {
  return (
    <span className={cx(s.chip, ACTOR_CLASS[actor])}>
      {ACTOR_ICON[actor]?.()}
      {label ?? actor}
    </span>
  );
}

// ---- Layout pieces ------------------------------------------------------------------------

export function PageHeader({
  title,
  description,
  actions,
  back,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  back?: { href: string; label: string };
}) {
  return (
    <header>
      {back && (
        <Link href={back.href} className={s.back}>
          <I.ArrowLeft size={14} />
          {back.label}
        </Link>
      )}
      <div className={s.pageHeader}>
        <div>
          <h1 className={s.pageTitle}>{title}</h1>
          {description && <p className={s.pageDescription}>{description}</p>}
        </div>
        {actions && <div className={s.actions}>{actions}</div>}
      </div>
    </header>
  );
}

export function BackLink({ href, label }: { href: string; label: string }) {
  return (
    <Link href={href} className={s.back}>
      <I.ArrowLeft size={14} />
      {label}
    </Link>
  );
}

export function Card({
  children,
  className,
}: {
  children: ReactNode;
  className?: string | undefined;
}) {
  return <div className={cx(s.card, className)}>{children}</div>;
}

/** A titled section; `actor` says which part of the system owns it (AI, Policy, Orchestrator). */
export function Section({
  id,
  title,
  description,
  actor,
  aside,
  children,
}: {
  id: string;
  title: string;
  description?: ReactNode;
  actor?: { kind: ActorKind; label: string };
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className={s.section}>
      <div className={s.sectionHead}>
        <div className={s.stack}>
          <h2 id={`${id}-title`} className={s.sectionTitle}>
            {title}
            {actor && <ActorChip actor={actor.kind} label={actor.label} />}
          </h2>
          {description && <p className={s.sectionDescription}>{description}</p>}
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}

export function Callout({
  tone,
  title,
  children,
  action,
  role,
}: {
  tone: "amber" | "red" | "blue" | "gray" | "green";
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  role?: "alert" | "status";
}) {
  const Icon = tone === "red" || tone === "amber" ? I.Alert : tone === "green" ? I.Check : I.Info;
  return (
    <div className={cx(s.callout, s[tone])} role={role}>
      <Icon size={18} />
      <div className={s.calloutBody}>
        <p className={s.calloutTitle} style={children ? undefined : { fontWeight: 500 }}>
          {title}
        </p>
        {children && <div className={s.calloutText}>{children}</div>}
      </div>
      {action && <div className={s.calloutAction}>{action}</div>}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className={s.empty}>{children}</p>;
}

// ---- Tables -------------------------------------------------------------------------------

export interface Column {
  key: string;
  label: string;
  /** Hidden on narrow screens (stacked rows keep the essentials). */
  hideMobile?: boolean;
  align?: "right";
  /** On narrow screens: shown full width without its column name (e.g. the row's subject). */
  primary?: boolean;
}

/**
 * A semantic table; on narrow screens rows stack and each cell shows its column name. A cell
 * given as null/undefined renders empty (and is hidden in the stacked layout).
 */
export function DataTable({
  caption,
  columns,
  rows,
}: {
  caption: string;
  columns: Column[];
  rows: { key: string; cells: Record<string, ReactNode | null | undefined> }[];
}) {
  return (
    <div className={s.tableWrap}>
      <table className={cx(s.table, s.responsive)}>
        <caption className={s.skip}>{caption}</caption>
        <thead>
          <tr>
            {columns.map((c) => (
              <th
                key={c.key}
                scope="col"
                className={cx(c.hideMobile && s.hideMobile, c.align === "right" && s.right)}
              >
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              {columns.map((c) => (
                <td
                  key={c.key}
                  data-label={c.primary ? "" : c.label}
                  data-empty={r.cells[c.key] == null ? "" : undefined}
                  className={cx(c.hideMobile && s.hideMobile, c.align === "right" && s.right)}
                >
                  {r.cells[c.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---- Technical details --------------------------------------------------------------------

/** Provenance kept available but out of the way: a closed disclosure. */
export function TechnicalDetails({
  children,
  summary = "Technical details",
}: {
  children: ReactNode;
  summary?: string;
}) {
  return (
    <details className={s.details}>
      <summary>{summary}</summary>
      <div className={s.detailsBody}>{children}</div>
    </details>
  );
}

export function Meta({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className={s.meta}>
      {items.map(([k, v]) => (
        <div key={k} style={{ display: "contents" }}>
          <dt>{k}</dt>
          <dd>{v ?? "—"}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A copyable identifier (selects whole on click; no JavaScript needed). */
export function Copy({ value }: { value: string }) {
  return <code className={s.copy}>{value}</code>;
}

export function Mono({ children }: { children: ReactNode }) {
  return <span className={s.mono}>{children}</span>;
}

// ---- Lifecycle ----------------------------------------------------------------------------

const STEP_CLASS: Record<StepStatus, string | undefined> = {
  done: s.lcDone,
  current: s.lcCurrent,
  upcoming: undefined,
  skipped: s.lcSkipped,
  failed: s.lcFailed,
};
const STEP_NOTE: Record<StepStatus, string> = {
  done: "Done",
  current: "Current step",
  upcoming: "Not started",
  skipped: "Not needed",
  failed: "Stopped here",
};

export function Lifecycle({
  steps,
  compact,
}: {
  steps: { label: string; status: StepStatus }[];
  /** Labels only (no per-step status line), for small spaces. */
  compact?: boolean;
}) {
  return (
    <ol className={cx(s.lifecycle, compact && s.lcCompact)} aria-label="Onboarding lifecycle">
      {steps.map((st) => (
        <li
          key={st.label}
          className={cx(s.lcStep, STEP_CLASS[st.status])}
          aria-current={st.status === "current" ? "step" : undefined}
        >
          <div className={s.lcTrack}>
            <span className={s.lcDot}>
              {st.status === "done" && <I.Check size={12} />}
              {st.status === "failed" && <I.Cross size={12} />}
            </span>
            <span className={s.lcLine} />
          </div>
          <div>
            <span className={s.lcLabel}>{st.label}</span>
            <span className={s.lcNote}> {STEP_NOTE[st.status]}</span>
          </div>
        </li>
      ))}
    </ol>
  );
}

// ---- Steps (new onboarding) ---------------------------------------------------------------

export function Steps({ steps, current }: { steps: string[]; current: number }) {
  return (
    <ol className={s.steps} aria-label="Steps">
      {steps.map((label, i) => (
        <li
          key={label}
          className={cx(s.step, i === current && s.stepCurrent, i < current && s.stepDone)}
          aria-current={i === current ? "step" : undefined}
        >
          <span className={s.stepNum}>{i < current ? <I.Check size={12} /> : i + 1}</span>
          {label}
        </li>
      ))}
    </ol>
  );
}

// ---- Misc ---------------------------------------------------------------------------------

export function Meter({ value, label }: { value: number; label: string }) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  return (
    <span className={s.meter} title={label}>
      <span aria-hidden="true">Confidence</span>
      <span className={s.meterTrack} aria-hidden="true">
        <span className={s.meterFill} style={{ width: `${pct}%`, display: "block" }} />
      </span>
      <span>{pct}%</span>
      <span className={s.skip}>{label}</span>
    </span>
  );
}

export function Field({
  label,
  htmlFor,
  hint,
  children,
  wide,
}: {
  label: string;
  htmlFor: string;
  hint?: ReactNode;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <div className={cx(s.field, wide && s.span2)}>
      <label className={s.label} htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {hint && <p className={s.hint}>{hint}</p>}
    </div>
  );
}

export const styles = s;
export { cx };
