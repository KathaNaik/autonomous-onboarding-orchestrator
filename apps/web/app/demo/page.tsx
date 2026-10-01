import Link from "next/link";
import { Badge } from "@/components/badge";
import { DEMO_SCENARIOS } from "@/lib/demo-data";

export const dynamic = "force-static";

/** (M10) Public demo index: three fixed synthetic scenarios. */
export default function DemoIndexPage() {
  return (
    <main>
      <h1>Onboarding demo</h1>
      <p>
        Three synthetic onboardings, rendered from bundled sample data. Nothing here reads or
        changes a real workflow, and nothing calls ServiceNow, Okta, GitHub or OpenAI.
      </p>
      <ul style={{ listStyle: "none", padding: 0 }}>
        {DEMO_SCENARIOS.map((s) => (
          <li
            key={s.slug}
            style={{ border: "1px solid #ddd", borderRadius: 6, padding: 12, marginBottom: 12 }}
          >
            <h2 style={{ margin: "0 0 4px", fontSize: 18 }}>
              <Link href={`/demo/${s.slug}`}>{s.title}</Link>
            </h2>
            <p style={{ margin: "4px 0" }}>
              <Badge value={s.state} /> {s.hire.jobTitle}
            </p>
            <p style={{ margin: 0 }}>{s.summary}</p>
          </li>
        ))}
      </ul>
    </main>
  );
}
