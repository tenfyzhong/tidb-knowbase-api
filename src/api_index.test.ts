import { describe, it, expect } from "vitest";

process.env.API_TOKEN = "test-secret-token";
process.env.TIDB_DATABASE_URL = "mysql://root:pass@localhost:4000/test";

import handler, { GET, POST } from "../api/index.js";

describe("Vercel Web Standard Handler (api/index.ts)", () => {
  it("should handle GET /openapi.json", async () => {
    const req = new Request("https://tidb-knowbase-api.tenfy.cn/openapi.json", {
      method: "GET"
    });
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.openapi).toBe("3.1.0");
  });

  it("should handle POST /oauth/register with JSON body", async () => {
    const req = new Request("https://tidb-knowbase-api.tenfy.cn/oauth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Mock Client",
        redirect_uris: ["http://127.0.0.1:8080/callback"]
      })
    });
    const res = await POST(req);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.client_id).toBeDefined();
    expect(body.client_name).toBe("Mock Client");
  });

  it("should handle default handler export", async () => {
    const req = new Request("https://tidb-knowbase-api.tenfy.cn/health", {
      method: "GET"
    });
    const res = await handler(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
  });
});
