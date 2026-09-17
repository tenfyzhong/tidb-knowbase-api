import { describe, it, expect, vi, beforeEach } from "vitest";
import { createApp } from "./app.js";
import { parseEnv } from "./config.js";
import type { TiDBClient, SearchResultItem } from "./db.js";
import { createPkceChallenge } from "./auth.js";

describe("app", () => {
  const env = parseEnv({
    API_TOKEN: "test-admin-secret-token",
    TIDB_DATABASE_URL: "mysql://localhost/test"
  });

  let mockDb: TiDBClient;
  let mockSearch: ReturnType<typeof vi.fn>;
  let mockUpsertChunks: ReturnType<typeof vi.fn>;
  let mockDeleteChunks: ReturnType<typeof vi.fn>;
  let mockClearChunks: ReturnType<typeof vi.fn>;
  let mockGetSyncState: ReturnType<typeof vi.fn>;
  let mockSaveSyncState: ReturnType<typeof vi.fn>;
  let mockPing: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockSearch = vi.fn().mockResolvedValue([
      {
        id: "notes:123:0",
        score: 0.95,
        text: "Sample indexed knowledge base chunk.",
        source: "notes",
        path: "intro.md",
        title: "Introduction",
        chunkIndex: 0
      }
    ] as SearchResultItem[]);

    mockUpsertChunks = vi.fn().mockResolvedValue(1);
    mockDeleteChunks = vi.fn().mockResolvedValue(1);
    mockClearChunks = vi.fn().mockResolvedValue({ deletedChunks: 5, deletedState: true });
    mockGetSyncState = vi.fn().mockResolvedValue({ files: { "intro.md": { hash: "abc", chunkCount: 1 } } });
    mockSaveSyncState = vi.fn().mockResolvedValue(undefined);
    mockPing = vi.fn().mockResolvedValue(true);

    mockDb = {
      search: mockSearch,
      upsertChunks: mockUpsertChunks,
      deleteChunks: mockDeleteChunks,
      clearChunks: mockClearChunks,
      getSyncState: mockGetSyncState,
      saveSyncState: mockSaveSyncState,
      ping: mockPing
    } as unknown as TiDBClient;
  });

  it("GET /health should return ok and db status", async () => {
    const app = createApp({ env, db: mockDb });
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.database).toBe("connected");
  });

  it("GET /favicon.svg and /favicon.ico should return svg", async () => {
    const app = createApp({ env, db: mockDb });
    const res = await app.request("/favicon.svg");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/svg+xml");
  });

  it("GET /openapi.json should return OpenAPI 3.1 specification", async () => {
    const app = createApp({ env, db: mockDb });
    const res = await app.request("/openapi.json");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.openapi).toBe("3.1.0");
    expect(body.paths["/search"]).toBeDefined();
  });

  describe("OAuth 2.1 Flow", () => {
    it("should discover authorization server and protected resource", async () => {
      const app = createApp({ env, db: mockDb });

      const resMeta = await app.request("/.well-known/oauth-protected-resource");
      expect(resMeta.status).toBe(200);
      const metaBody = await resMeta.json();
      expect(metaBody.scopes_supported).toContain("search:read");

      const resAuth = await app.request("/.well-known/oauth-authorization-server");
      expect(resAuth.status).toBe(200);
      const authBody = await resAuth.json();
      expect(authBody.response_types_supported).toContain("code");
    });

    it("should register client, authorize, and exchange token with PKCE", async () => {
      const app = createApp({ env, db: mockDb });

      // 1. Register Client
      const regRes = await app.request("/oauth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: "Test Client",
          redirect_uris: ["http://127.0.0.1:8080/callback"]
        })
      });
      expect(regRes.status).toBe(201);
      const regBody = await regRes.json();
      const clientId = regBody.client_id;
      expect(clientId).toBeDefined();

      // 2. PKCE Setup
      const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
      const challenge = await createPkceChallenge(verifier);

      // 3. GET /oauth/authorize (UI)
      const authorizeUiRes = await app.request(
        `/oauth/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=http://127.0.0.1:8080/callback&code_challenge=${challenge}&code_challenge_method=S256&state=state123`
      );
      expect(authorizeUiRes.status).toBe(200);
      const html = await authorizeUiRes.text();
      expect(html).toContain("Connect Knowledge Base");

      // 4. POST /oauth/authorize (Approve with correct API_TOKEN)
      const approveRes = await app.request(
        `/oauth/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=http://127.0.0.1:8080/callback&code_challenge=${challenge}&code_challenge_method=S256&state=state123`,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: "api_token=test-admin-secret-token"
        }
      );
      expect(approveRes.status).toBe(302);
      const location = approveRes.headers.get("Location")!;
      expect(location).toContain("http://127.0.0.1:8080/callback");
      const redirectUrl = new URL(location);
      const code = redirectUrl.searchParams.get("code")!;
      expect(code).toBeDefined();
      expect(redirectUrl.searchParams.get("state")).toBe("state123");

      // 5. POST /oauth/token (Exchange code)
      const tokenRes = await app.request("/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "authorization_code",
          client_id: clientId,
          redirect_uri: "http://127.0.0.1:8080/callback",
          code,
          code_verifier: verifier
        })
      });
      expect(tokenRes.status).toBe(200);
      const tokenBody = await tokenRes.json();
      expect(tokenBody.access_token).toBeDefined();
      expect(tokenBody.refresh_token).toBeDefined();

      const accessToken = tokenBody.access_token;
      const refreshToken = tokenBody.refresh_token;

      // 6. GET /oauth/verify
      const verifyRes = await app.request("/oauth/verify", {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      expect(verifyRes.status).toBe(200);
      const verifyBody = await verifyRes.json();
      expect(verifyBody.valid).toBe(true);

      // 7. Refresh token
      const refreshRes = await app.request("/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "refresh_token",
          refresh_token: refreshToken
        })
      });
      expect(refreshRes.status).toBe(200);
      const refreshedBody = await refreshRes.json();
      expect(refreshedBody.access_token).toBeDefined();
    });
  });

  describe("POST /search", () => {
    it("should reject request without bearer token", async () => {
      const app = createApp({ env, db: mockDb });
      const res = await app.request("/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "how to install TiDB" })
      });
      expect(res.status).toBe(401);
    });

    it("should execute search directly with raw text query in auto embedding mode", async () => {
      const app = createApp({ env, db: mockDb });
      const res = await app.request("/search", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.API_TOKEN}`
        },
        body: JSON.stringify({ query: "how to install TiDB", topK: 3 })
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.query).toBe("how to install TiDB");
      expect(body.count).toBe(1);
      expect(body.results).toHaveLength(1);
      expect(mockSearch).toHaveBeenCalledWith("how to install TiDB", { topK: 3, source: undefined });
    });
  });

  describe("POST /mcp", () => {
    it("should return 401 challenge with WWW-Authenticate when unauthenticated", async () => {
      const app = createApp({ env, db: mockDb });
      const res = await app.request("/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })
      });
      expect(res.status).toBe(401);
      expect(res.headers.get("WWW-Authenticate")).toContain("Bearer resource_metadata=");
    });

    it("should reject unsupported methods on /mcp", async () => {
      const app = createApp({ env, db: mockDb });
      const res = await app.request("/mcp", { method: "PUT" });
      expect(res.status).toBe(405);
    });

    it("should support GET /mcp and GET /sse with SSE stream", async () => {
      const app = createApp({ env, db: mockDb });
      const unauthRes = await app.request("/mcp", { method: "GET" });
      expect(unauthRes.status).toBe(401);

      const authRes = await app.request("/mcp", {
        method: "GET",
        headers: { Authorization: `Bearer ${env.API_TOKEN}` }
      });
      expect(authRes.status).toBe(200);
      expect(authRes.headers.get("Content-Type")).toContain("text/event-stream");
      expect(authRes.headers.get("Mcp-Session-Id")).toBeDefined();
    });
    it("should handle CORS preflight OPTIONS request on /mcp", async () => {
      const app = createApp({ env, db: mockDb });
      const res = await app.request("/mcp", {
        method: "OPTIONS",
        headers: {
          Origin: "http://localhost:3000",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "Authorization, Content-Type, Mcp-Session-Id"
        }
      });
      expect(res.status).toBe(204);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    });

    it("should authorize via X-API-Token header or query token", async () => {
      const app = createApp({ env, db: mockDb });

      // X-API-Token header
      const headerRes = await app.request("/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Token": env.API_TOKEN
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 10, method: "ping" })
      });
      expect(headerRes.status).toBe(200);

      // Query param
      const queryRes = await app.request(`/mcp?token=${env.API_TOKEN}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 11, method: "ping" })
      });
      expect(queryRes.status).toBe(200);
    });

    it("should handle MCP initialize", async () => {
      const app = createApp({ env, db: mockDb });
      const res = await app.request("/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.API_TOKEN}`
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "init-1",
          method: "initialize",
          params: { protocolVersion: "2025-06-18" }
        })
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.jsonrpc).toBe("2.0");
      expect(body.id).toBe("init-1");
      expect(body.result.serverInfo.name).toBe("tidb-knowbase");
    });

    it("should handle MCP ping", async () => {
      const app = createApp({ env, db: mockDb });
      const res = await app.request("/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.API_TOKEN}`
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" })
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.result).toEqual({});
    });

    it("should handle MCP tools/list", async () => {
      const app = createApp({ env, db: mockDb });
      const res = await app.request("/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.API_TOKEN}`
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" })
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.result.tools).toHaveLength(1);
      expect(body.result.tools[0].name).toBe("search_knowledge_base");
    });

    it("should handle MCP tools/call for search_knowledge_base", async () => {
      const app = createApp({ env, db: mockDb });
      const res = await app.request("/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.API_TOKEN}`
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 4,
          method: "tools/call",
          params: {
            name: "search_knowledge_base",
            arguments: { query: "what is TiDB vector?", topK: 5 }
          }
        })
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.result.isError).toBe(false);
      expect(body.result.structuredContent.results).toHaveLength(1);
      expect(body.result.content[0].type).toBe("text");
      expect(mockSearch).toHaveBeenCalledWith("what is TiDB vector?", { topK: 5, source: undefined });
    });

    it("should handle MCP notifications by returning 202", async () => {
      const app = createApp({ env, db: mockDb });
      const res = await app.request("/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.API_TOKEN}`
        },
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })
      });
      expect(res.status).toBe(202);
    });
  });

  describe("Administrative Vector Endpoints", () => {
    it("should upsert chunks with valid API_TOKEN", async () => {
      const app = createApp({ env, db: mockDb });
      const res = await app.request("/vectors/upsert", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.API_TOKEN}`
        },
        body: JSON.stringify({
          items: [
            {
              id: "notes:1:0",
              text: "Sample text for indexing",
              source: "notes",
              path: "guide.md"
            }
          ]
        })
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(mockUpsertChunks).toHaveBeenCalledTimes(1);
    });

    it("should delete chunks with valid API_TOKEN", async () => {
      const app = createApp({ env, db: mockDb });
      const res = await app.request("/vectors/delete", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.API_TOKEN}`
        },
        body: JSON.stringify({ ids: ["notes:1:0"] })
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(mockDeleteChunks).toHaveBeenCalledTimes(1);
    });

    it("should clear vectors with valid API_TOKEN", async () => {
      const app = createApp({ env, db: mockDb });
      const res = await app.request("/vectors/clear?source=notes", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.API_TOKEN}`
        }
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(mockClearChunks).toHaveBeenCalledWith("notes");
    });

    it("should get and put sync state", async () => {
      const app = createApp({ env, db: mockDb });

      const getRes = await app.request("/sync-state/notes", {
        headers: { Authorization: `Bearer ${env.API_TOKEN}` }
      });
      expect(getRes.status).toBe(200);

      const putRes = await app.request("/sync-state/notes", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.API_TOKEN}`
        },
        body: JSON.stringify({ files: { "test.md": { hash: "xyz", chunkCount: 1 } } })
      });
      expect(putRes.status).toBe(200);
      expect(mockSaveSyncState).toHaveBeenCalledTimes(1);
    });
  });
});
