import { HealthResponseSchema } from "@aoo/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GET } from "@/app/api/health/route";
import HomePage from "@/app/page";

describe("GET /api/health", () => {
  it("returns 200 with a body matching the shared schema", async () => {
    const res = GET();

    expect(res.status).toBe(200);
    const body = HealthResponseSchema.parse(await res.json());
    expect(body.service).toBe("web");
  });
});

describe("HomePage", () => {
  it("renders the product name", () => {
    expect(renderToStaticMarkup(<HomePage />)).toContain("Swift");
  });
});
