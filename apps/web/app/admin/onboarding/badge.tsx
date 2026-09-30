import { humanize, toneOf, type Tone } from "@/lib/dashboard-model";

const STYLES: Record<Tone, { background: string; color: string; border: string }> = {
  done: { background: "#e6f4ea", color: "#0d5a24", border: "#7cc493" },
  active: { background: "#e8f0fe", color: "#1a4a9c", border: "#8ab0f0" },
  waiting: { background: "#fef7e0", color: "#6b4e00", border: "#e4c25c" },
  blocked: { background: "#fce8e6", color: "#8c1d18", border: "#e39a93" },
  neutral: { background: "#f1f3f4", color: "#3c4043", border: "#c4c7c5" },
};

/** A state badge: the text is always visible (color is only a secondary cue). */
export function Badge({
  value,
  label,
}: {
  value: string | null | undefined;
  label?: string | undefined;
}) {
  const s = STYLES[toneOf(value)];
  return (
    <span
      data-state={value ?? "NONE"}
      style={{
        ...s,
        border: `1px solid ${s.border}`,
        borderRadius: 4,
        padding: "1px 6px",
        fontSize: 12,
        fontFamily: "ui-monospace, monospace",
        whiteSpace: "nowrap",
      }}
    >
      {label ?? value ?? "Not available"}
    </span>
  );
}

export { humanize };
