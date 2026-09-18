import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { parseEnv, type Env } from "./config.js";
import { TiDBClient, type SearchResultItem, type ChunkItem } from "./db.js";
import {
  MCP_SCOPE,
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_TTL_SECONDS,
  AUTHORIZATION_CODE_TTL_SECONDS,
  type OAuthClient,
  type AuthorizationCodeGrant,
  type OAuthTokenGrant,
  parseOAuthRedirectUri,
  redirectUriMatches,
  signOAuthValue,
  verifyOAuthValue,
  createPkceChallenge,
  isApiTokenAuthorized,
  getOAuthTokenGrant,
  isMcpAuthorized,
  htmlEscape
} from "./auth.js";

export const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
  <defs>
    <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0284c7"/>
      <stop offset="100%" stop-color="#0f172a"/>
    </linearGradient>
    <linearGradient id="cylinderGrad" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#38bdf8"/>
      <stop offset="100%" stop-color="#0284c7"/>
    </linearGradient>
  </defs>
  <rect x="2" y="2" width="60" height="60" rx="14" fill="url(#bgGrad)"/>
  <!-- Database Disks -->
  <ellipse cx="32" cy="18" rx="18" ry="6" fill="#7dd3fc"/>
  <path d="M 14 18 V 26 C 14 30 50 30 50 26 V 18 Z" fill="url(#cylinderGrad)"/>
  <ellipse cx="32" cy="26" rx="18" ry="5.5" fill="#38bdf8"/>
  <path d="M 14 26 V 34 C 14 38 50 38 50 34 V 26 Z" fill="url(#cylinderGrad)"/>
  <ellipse cx="32" cy="34" rx="18" ry="5.5" fill="#0284c7"/>
  <path d="M 14 34 V 42 C 14 46 50 46 50 42 V 34 Z" fill="#0369a1"/>
  <ellipse cx="32" cy="42" rx="18" ry="5.5" fill="#0284c7"/>
  <!-- Vector Sparkles -->
  <circle cx="22" cy="49" r="2.5" fill="#facc15"/>
  <circle cx="32" cy="51" r="3" fill="#facc15"/>
  <circle cx="42" cy="49" r="2.5" fill="#facc15"/>
</svg>`;

export const SearchRequestSchema = z.object({
  query: z.string().trim().min(1),
  topK: z.number().int().min(1).max(50).default(5),
  source: z.string().optional()
});

export const UpsertChunkItemSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  source: z.string().min(1),
  path: z.string().min(1),
  title: z.string().optional(),
  chunkIndex: z.number().int().min(0).default(0),
  url: z.string().optional()
});

export const UpsertRequestSchema = z.object({
  items: z.array(UpsertChunkItemSchema)
});

export const DeleteRequestSchema = z.object({
  ids: z.array(z.string().min(1))
});

export const SEARCH_TOOL = {
  name: "search_knowledge_base",
  description:
    "Semantically search personal notes, documentation, repositories, and articles stored in the knowledge base.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Natural language search query or semantic keywords."
      },
      topK: {
        type: "integer",
        description: "Maximum number of most relevant search results to return (1-50, default: 5).",
        minimum: 1,
        maximum: 50,
        default: 5
      },
      source: {
        type: "string",
        description: "Optional filter by exact source name."
      }
    },
    required: ["query"]
  }
};

export interface AppOptions {
  env?: Env;
  db?: TiDBClient;
}

export function createApp(options: AppOptions = {}): Hono {
  const app = new Hono();

  app.use(
    "*",
    cors({
      origin: "*",
      allowHeaders: [
        "Content-Type",
        "Authorization",
        "X-API-Token",
        "x-api-token",
        "Mcp-Session-Id",
        "mcp-session-id",
        "MCP-Protocol-Version",
        "mcp-protocol-version",
        "Last-Event-ID",
        "last-event-id"
      ],
      exposeHeaders: ["Mcp-Session-Id", "mcp-session-id", "Content-Type"],
      allowMethods: ["GET", "POST", "OPTIONS", "DELETE"]
    })
  );

  const activeSessions = new Map<
    string,
    {
      id: string;
      send: (msg: unknown) => Promise<void>;
    }
  >();
  // Lazy or provided dependencies
  let cachedEnv: Env | null = options.env || null;
  let cachedDb: TiDBClient | null = options.db || null;

  function getEnv(): Env {
    if (!cachedEnv) {
      cachedEnv = parseEnv(process.env);
    }
    return cachedEnv;
  }

  function getDb(): TiDBClient {
    if (!cachedDb) {
      cachedDb = new TiDBClient(getEnv());
    }
    return cachedDb;
  }
  function getOrigin(c: Context): string {
    const url = new URL(c.req.url);
    const forwardedProto = c.req.header("x-forwarded-proto");
    const forwardedHost = c.req.header("x-forwarded-host");
    const host = forwardedHost || c.req.header("host") || url.host;

    let proto = forwardedProto || (url.protocol ? url.protocol.replace(":", "") : "http");
    if (!host.startsWith("localhost") && !host.startsWith("127.0.0.1") && !host.startsWith("[::1]")) {
      proto = "https";
    }

    return `${proto}://${host}`;
  }

  function oauthChallenge(origin: string, description: string): string {
    return `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource", error="invalid_token", error_description="${description}"`;
  }

  // --- Health & Favicon ---
  app.get("/health", async (c) => {
    const isDbConnected = await getDb().ping();
    return c.json({
      status: "ok",
      database: isDbConnected ? "connected" : "error"
    });
  });

  app.get("/favicon.svg", (c) => {
    c.header("Content-Type", "image/svg+xml");
    c.header("Cache-Control", "public, max-age=86400");
    return c.body(FAVICON_SVG);
  });

  app.get("/favicon.ico", (c) => {
    c.header("Content-Type", "image/svg+xml");
    c.header("Cache-Control", "public, max-age=86400");
    return c.body(FAVICON_SVG);
  });

  // --- OAuth 2.1 Discovery Endpoints ---
  app.get("/.well-known/oauth-protected-resource", (c) => {
    const origin = getOrigin(c);
    return c.json({
      resource: `${origin}/mcp`,
      authorization_servers: [origin],
      scopes_supported: [MCP_SCOPE]
    });
  });

  app.get("/.well-known/oauth-authorization-server", (c) => {
    const origin = getOrigin(c);
    return c.json({
      issuer: origin,
      authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/oauth/token`,
      registration_endpoint: `${origin}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      scopes_supported: [MCP_SCOPE]
    });
  });

  // --- OAuth Dynamic Registration ---
  app.post("/oauth/register", async (c) => {
    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "invalid_request", error_description: "Invalid JSON" }, 400);
    }

    const rawRedirectUris = body.redirect_uris;
    if (!Array.isArray(rawRedirectUris) || rawRedirectUris.length === 0) {
      return c.json(
        { error: "invalid_redirect_uri", error_description: "redirect_uris must be a non-empty array" },
        400
      );
    }

    const redirectUris: string[] = [];
    for (const uri of rawRedirectUris) {
      if (typeof uri !== "string" || !parseOAuthRedirectUri(uri)) {
        return c.json(
          { error: "invalid_redirect_uri", error_description: `Invalid redirect URI: ${uri}` },
          400
        );
      }
      redirectUris.push(uri);
    }

    const clientData: OAuthClient = {
      id: crypto.randomUUID(),
      redirectUris,
      createdAt: Date.now()
    };

    const env = getEnv();
    const clientId = await signOAuthValue(env.API_TOKEN, "kb_client_", clientData);

    return c.json(
      {
        client_id: clientId,
        client_name: typeof body.client_name === "string" ? body.client_name : "MCP Client",
        redirect_uris: redirectUris,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none"
      },
      201
    );
  });

  // --- OAuth Authorize Endpoint ---
  app.all("/oauth/authorize", async (c) => {
    const url = new URL(c.req.url);
    const origin = getOrigin(c);
    const env = getEnv();

    const responseType = url.searchParams.get("response_type") || "";
    const clientId = url.searchParams.get("client_id") || "";
    const redirectUri = url.searchParams.get("redirect_uri") || "";
    const codeChallenge = url.searchParams.get("code_challenge") || "";
    const codeChallengeMethod = url.searchParams.get("code_challenge_method") || "";
    const state = url.searchParams.get("state") || "";
    const resource = url.searchParams.get("resource") || `${origin}/mcp`;

    if (responseType !== "code") {
      return c.text("unsupported_response_type", 400);
    }

    const client = await verifyOAuthValue<OAuthClient>(env.API_TOKEN, "kb_client_", clientId);
    if (!client) {
      return c.text("invalid_client", 400);
    }

    const matched = client.redirectUris.some((regUri) => redirectUriMatches(regUri, redirectUri));
    if (!matched) {
      return c.text("invalid_redirect_uri", 400);
    }

    if (codeChallengeMethod && codeChallengeMethod !== "S256") {
      return c.text("invalid_request: code_challenge_method must be S256", 400);
    }

    // Handle user authorization approval form submission
    if (c.req.method === "POST") {
      let enteredToken = "";
      try {
        const contentType = c.req.header("content-type") || "";
        if (contentType.includes("application/json")) {
          const json = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
          enteredToken = String(json.api_token || "");
        } else {
          const body = (await c.req.parseBody().catch(() => ({}))) as Record<string, unknown>;
          enteredToken = String(body.api_token || "");
          if (!enteredToken) {
            const formData = await c.req.formData().catch(() => null);
            if (formData) {
              enteredToken = String(formData.get("api_token") || "");
            }
          }
          if (!enteredToken) {
            const json = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
            enteredToken = String(json.api_token || "");
          }
        }
      } catch {
        // ignore parsing errors
      }

      enteredToken = enteredToken.trim();

      if (!enteredToken || enteredToken !== env.API_TOKEN.trim()) {
        return c.html(
          renderAuthorizePage({
            origin,
            clientId,
            redirectUri,
            state,
            codeChallenge,
            codeChallengeMethod,
            resource,
            error: "Invalid API Token. Please check your token and try again."
          }),
          401
        );
      }

      const grant: AuthorizationCodeGrant = {
        id: crypto.randomUUID(),
        clientId,
        redirectUri,
        scope: MCP_SCOPE,
        resource,
        codeChallenge: codeChallenge || undefined,
        expiresAt: Date.now() + AUTHORIZATION_CODE_TTL_SECONDS * 1000
      };

      const code = await signOAuthValue(env.API_TOKEN, "kb_code_", grant);
      const redirectTarget = new URL(redirectUri);
      redirectTarget.searchParams.set("code", code);
      if (state) {
        redirectTarget.searchParams.set("state", state);
      }

      return c.redirect(redirectTarget.toString(), 302);
    }

    // GET: display approval UI
    return c.html(
      renderAuthorizePage({
        origin,
        clientId,
        redirectUri,
        state,
        codeChallenge,
        codeChallengeMethod,
        resource
      })
    );
  });

  // --- OAuth Token Endpoint ---
  app.post("/oauth/token", async (c) => {
    c.header("Cache-Control", "no-store");
    c.header("Pragma", "no-cache");

    const env = getEnv();
    let body: Record<string, unknown> = {};
    const contentType = c.req.header("content-type") || "";

    if (contentType.includes("application/x-www-form-urlencoded")) {
      const formData = await c.req.formData();
      formData.forEach((val, key) => {
        body[key] = val;
      });
    } else {
      body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    }

    const grantType = String(body.grant_type || "");

    if (grantType === "authorization_code") {
      const code = String(body.code || "");
      const redirectUri = String(body.redirect_uri || "");
      const clientId = String(body.client_id || "");
      const codeVerifier = String(body.code_verifier || "");

      const grant = await verifyOAuthValue<AuthorizationCodeGrant>(env.API_TOKEN, "kb_code_", code);
      if (!grant || grant.expiresAt <= Date.now()) {
        return c.json({ error: "invalid_grant", error_description: "Invalid or expired authorization code" }, 400);
      }

      if (grant.redirectUri && !redirectUriMatches(grant.redirectUri, redirectUri)) {
        return c.json({ error: "invalid_grant", error_description: "redirect_uri mismatch" }, 400);
      }

      if (grant.codeChallenge) {
        if (!codeVerifier) {
          return c.json({ error: "invalid_grant", error_description: "code_verifier required" }, 400);
        }
        const calculatedChallenge = await createPkceChallenge(codeVerifier);
        if (calculatedChallenge !== grant.codeChallenge) {
          return c.json({ error: "invalid_grant", error_description: "PKCE verification failed" }, 400);
        }
      }

      const tokenGrant: OAuthTokenGrant = {
        id: crypto.randomUUID(),
        clientId: grant.clientId,
        scope: grant.scope,
        resource: grant.resource,
        expiresAt: Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000
      };

      const refreshGrant: OAuthTokenGrant = {
        id: crypto.randomUUID(),
        clientId: grant.clientId,
        scope: grant.scope,
        resource: grant.resource,
        expiresAt: Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000
      };

      const accessToken = await signOAuthValue(env.API_TOKEN, "kb_at_", tokenGrant);
      const refreshToken = await signOAuthValue(env.API_TOKEN, "kb_rt_", refreshGrant);

      return c.json({
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: ACCESS_TOKEN_TTL_SECONDS,
        refresh_token: refreshToken,
        scope: grant.scope
      });
    }

    if (grantType === "refresh_token") {
      const refreshToken = String(body.refresh_token || "");
      const grant = await verifyOAuthValue<OAuthTokenGrant>(env.API_TOKEN, "kb_rt_", refreshToken);
      if (!grant || grant.expiresAt <= Date.now()) {
        return c.json({ error: "invalid_grant", error_description: "Invalid or expired refresh token" }, 400);
      }

      const nextTokenGrant: OAuthTokenGrant = {
        id: crypto.randomUUID(),
        clientId: grant.clientId,
        scope: grant.scope,
        resource: grant.resource,
        expiresAt: Date.now() + ACCESS_TOKEN_TTL_SECONDS * 1000
      };

      const nextRefreshGrant: OAuthTokenGrant = {
        id: crypto.randomUUID(),
        clientId: grant.clientId,
        scope: grant.scope,
        resource: grant.resource,
        expiresAt: Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000
      };

      const accessToken = await signOAuthValue(env.API_TOKEN, "kb_at_", nextTokenGrant);
      const nextRefreshToken = await signOAuthValue(env.API_TOKEN, "kb_rt_", nextRefreshGrant);

      return c.json({
        access_token: accessToken,
        token_type: "Bearer",
        expires_in: ACCESS_TOKEN_TTL_SECONDS,
        refresh_token: nextRefreshToken,
        scope: grant.scope
      });
    }

    return c.json({ error: "unsupported_grant_type" }, 400);
  });

  // --- OAuth Verify Endpoint ---
  app.get("/oauth/verify", async (c) => {
    const env = getEnv();
    const grant = await getOAuthTokenGrant(c, env.API_TOKEN);
    if (!grant) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    return c.json({
      valid: true,
      clientId: grant.clientId,
      scope: grant.scope,
      resource: grant.resource,
      expiresAt: grant.expiresAt
    });
  });

  // --- OpenAPI 3.1.0 Specification ---
  app.get("/openapi.json", (c) => {
    const origin = getOrigin(c);
    return c.json({
      openapi: "3.1.0",
      info: {
        title: "TiDB Knowledge Base API",
        version: "1.0.0",
        description: "Semantic search and knowledge base API powered by TiDB Cloud Starter"
      },
      servers: [{ url: origin }],
      paths: {
        "/search": {
          post: {
            summary: "Search knowledge base",
            operationId: "searchKnowledgeBase",
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["query"],
                    properties: {
                      query: { type: "string" },
                      topK: { type: "integer", default: 5 },
                      source: { type: "string" }
                    }
                  }
                }
              }
            },
            responses: {
              "200": { description: "Search results" }
            }
          }
        }
      }
    });
  });

  // --- Semantic Search REST Endpoint ---
  app.post("/search", async (c) => {
    const env = getEnv();
    const authorized = await isMcpAuthorized(c, env.API_TOKEN);
    if (!authorized) {
      return c.json({ error: "Unauthorized: Missing or invalid Bearer token" }, 401);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Bad Request: Invalid JSON body" }, 400);
    }

    const parsed = SearchRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Bad Request", details: parsed.error.format() }, 400);
    }

    const { query, topK, source } = parsed.data;
    const results = await getDb().search(query, { topK, source });

    return c.json({
      query,
      count: results.length,
      results
    });
  });

  // --- Remote HTTP Streamable & SSE MCP Endpoints ---
  const handleMcpSse = async (c: Context) => {
    const origin = getOrigin(c);
    const env = getEnv();

    const authorized = await isMcpAuthorized(c, env.API_TOKEN, `${origin}/mcp`);
    if (!authorized) {
      c.header("WWW-Authenticate", oauthChallenge(origin, "Connect Knowbase to search private data"));
      return c.json(
        {
          error: "unauthorized",
          error_description: "A valid Bearer token, X-API-Token, or query token is required"
        },
        401
      );
    }

    const existingSessionId =
      c.req.header("mcp-session-id") ||
      c.req.header("Mcp-Session-Id") ||
      c.req.query("sessionId");

    const sessionId = existingSessionId || crypto.randomUUID();
    c.header("Mcp-Session-Id", sessionId);

    return streamSSE(c, async (stream) => {
      activeSessions.set(sessionId, {
        id: sessionId,
        send: async (msg: unknown) => {
          await stream.writeSSE({
            event: "message",
            data: JSON.stringify(msg)
          });
        }
      });

      stream.onAbort(() => {
        activeSessions.delete(sessionId);
      });

      const queryToken =
        c.req.query("token") ||
        c.req.query("api_token") ||
        c.req.query("apiKey") ||
        c.req.query("key");
      const tokenParam = queryToken ? `&token=${encodeURIComponent(queryToken)}` : "";

      // Send initial endpoint event for legacy SSE transport
      await stream.writeSSE({
        event: "endpoint",
        data: `/mcp?sessionId=${sessionId}${tokenParam}`
      });

      // Keepalive ping every 15s to keep the SSE connection alive
      while (!stream.aborted) {
        await stream.sleep(15_000);
        try {
          await stream.write(": keepalive\n\n");
        } catch {
          break;
        }
      }
    });
  };

  app.get("/mcp", handleMcpSse);
  app.get("/sse", handleMcpSse);

  app.delete("/mcp", (c) => {
    const sessionId =
      c.req.header("mcp-session-id") ||
      c.req.header("Mcp-Session-Id") ||
      c.req.query("sessionId");
    if (sessionId) {
      activeSessions.delete(sessionId);
    }
    return c.body(null, 204);
  });

  app.post("/mcp", async (c) => {
    const origin = getOrigin(c);
    const env = getEnv();

    const authorized = await isMcpAuthorized(c, env.API_TOKEN, `${origin}/mcp`);
    if (!authorized) {
      c.header("WWW-Authenticate", oauthChallenge(origin, "Connect Knowbase to search private data"));
      return c.json(
        {
          error: "unauthorized",
          error_description: "A valid Bearer token, X-API-Token, or query token is required"
        },
        401
      );
    }

    const requestedSessionId =
      c.req.header("mcp-session-id") ||
      c.req.header("Mcp-Session-Id") ||
      c.req.query("sessionId");
    const sessionId = requestedSessionId || crypto.randomUUID();
    c.header("Mcp-Session-Id", sessionId);

    let message: {
      jsonrpc?: string;
      id?: string | number | null;
      method?: string;
      params?: Record<string, unknown>;
    };

    try {
      message = (await c.req.json()) as typeof message;
    } catch {
      return c.json({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "Parse error" }
      });
    }

    const id = message.id ?? null;
    if (message.jsonrpc !== "2.0" || !message.method) {
      return c.json({
        jsonrpc: "2.0",
        id,
        error: { code: -32600, message: "Invalid Request" }
      });
    }

    // Handle notifications (no response required)
    if (message.method.startsWith("notifications/")) {
      return c.body(null, 202);
    }

    let response: unknown;

    // MCP initialize
    if (message.method === "initialize") {
      const params = message.params || {};
      const protocolVersion =
        typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-06-18";

      response = {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "tidb-knowbase", version: "1.0.0" },
          instructions:
            "Use search_knowledge_base for semantic retrieval from the user's private knowledge base."
        }
      };
    } else if (message.method === "ping") {
      response = { jsonrpc: "2.0", id, result: {} };
    } else if (message.method === "tools/list") {
      response = {
        jsonrpc: "2.0",
        id,
        result: { tools: [SEARCH_TOOL] }
      };
    } else if (message.method === "tools/call") {
      const params = message.params || {};
      if (params.name !== SEARCH_TOOL.name) {
        response = {
          jsonrpc: "2.0",
          id,
          error: { code: -32602, message: "Unknown tool" }
        };
      } else {
        const parsedArgs = SearchRequestSchema.safeParse(params.arguments || {});
        if (!parsedArgs.success) {
          response = {
            jsonrpc: "2.0",
            id,
            error: {
              code: -32602,
              message: "Invalid tool arguments",
              data: parsedArgs.error.format()
            }
          };
        } else {
          try {
            const { query, topK, source } = parsedArgs.data;
            const results = await getDb().search(query, { topK, source });
            const responseData = {
              query,
              count: results.length,
              results
            };

            response = {
              jsonrpc: "2.0",
              id,
              result: {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify(responseData)
                  }
                ],
                structuredContent: responseData,
                isError: false
              }
            };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            response = {
              jsonrpc: "2.0",
              id,
              result: {
                content: [{ type: "text", text: `Search failed: ${msg}` }],
                isError: true
              }
            };
          }
        }
      }
    } else {
      response = {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: "Method not found" }
      };
    }

    // If an active SSE session exists for this sessionId, send response through the stream
    const activeSession = activeSessions.get(sessionId);
    if (activeSession) {
      await activeSession.send(response);
      return c.body(null, 202);
    }

    // If client requested text/event-stream exclusively
    const accept = c.req.header("Accept") || "";
    if (accept.includes("text/event-stream") && !accept.includes("application/json")) {
      c.header("Content-Type", "text/event-stream");
      c.header("Cache-Control", "no-cache");
      return c.body(`event: message\ndata: ${JSON.stringify(response)}\n\n`);
    }

    return c.json(response);
  });

  app.on(["PUT", "PATCH"], "/mcp", (c) => {
    c.header("Allow", "GET, POST, DELETE, OPTIONS");
    return c.json({ error: "Method Not Allowed" }, 405);
  });

  // --- Administrative Vector & Sync State Endpoints ---
  app.post("/vectors/upsert", async (c) => {
    const env = getEnv();
    if (!isApiTokenAuthorized(c, env.API_TOKEN)) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Bad Request: Invalid JSON" }, 400);
    }

    const parsed = UpsertRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Bad Request", details: parsed.error.format() }, 400);
    }

    const { items } = parsed.data;
    if (items.length === 0) {
      return c.json({ success: true, count: 0 });
    }

    const count = await getDb().upsertChunks(items);
    return c.json({ success: true, count });
  });

  app.post("/vectors/delete", async (c) => {
    const env = getEnv();
    if (!isApiTokenAuthorized(c, env.API_TOKEN)) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Bad Request: Invalid JSON" }, 400);
    }

    const parsed = DeleteRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Bad Request", details: parsed.error.format() }, 400);
    }

    const count = await getDb().deleteChunks(parsed.data.ids);
    return c.json({ success: true, count });
  });

  app.post("/vectors/clear", async (c) => {
    const env = getEnv();
    if (!isApiTokenAuthorized(c, env.API_TOKEN)) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const source = c.req.query("source");
    const result = await getDb().clearChunks(source);
    return c.json({ success: true, ...result });
  });

  app.get("/sync-state/:source", async (c) => {
    const env = getEnv();
    if (!isApiTokenAuthorized(c, env.API_TOKEN)) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const source = c.req.param("source");
    const state = await getDb().getSyncState(source);
    if (!state) {
      return c.json({ error: "Not Found", message: `No sync state found for source: ${source}` }, 404);
    }

    return c.json(state);
  });

  app.put("/sync-state/:source", async (c) => {
    const env = getEnv();
    if (!isApiTokenAuthorized(c, env.API_TOKEN)) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const source = c.req.param("source");
    let state: unknown;
    try {
      state = await c.req.json();
    } catch {
      return c.json({ error: "Bad Request: Invalid JSON" }, 400);
    }

    await getDb().saveSyncState(source, state as Parameters<TiDBClient["saveSyncState"]>[1]);
    return c.json({ success: true, source });
  });

  return app;
}

function renderAuthorizePage(params: {
  origin: string;
  clientId: string;
  redirectUri: string;
  state?: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
  resource?: string;
  error?: string;
}): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Authorize Knowledge Base</title>
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: #0f172a;
      color: #f8fafc;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      margin: 0;
      padding: 20px;
      box-sizing: border-box;
    }
    .card {
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: 16px;
      max-width: 440px;
      width: 100%;
      padding: 32px;
      box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.5);
    }
    .header {
      text-align: center;
      margin-bottom: 24px;
    }
    .logo {
      width: 56px;
      height: 56px;
      margin-bottom: 12px;
    }
    h1 {
      font-size: 20px;
      font-weight: 600;
      margin: 0 0 8px 0;
      color: #f8fafc;
    }
    p {
      font-size: 14px;
      color: #94a3b8;
      margin: 0 0 24px 0;
      line-height: 1.5;
    }
    .error {
      background: #450a0a;
      border: 1px solid #991b1b;
      color: #fca5a5;
      padding: 12px;
      border-radius: 8px;
      font-size: 13px;
      margin-bottom: 20px;
    }
    label {
      display: block;
      font-size: 13px;
      font-weight: 500;
      margin-bottom: 6px;
      color: #cbd5e1;
    }
    input[type="password"] {
      width: 100%;
      padding: 12px;
      background: #0f172a;
      border: 1px solid #475569;
      border-radius: 8px;
      color: #f8fafc;
      font-size: 14px;
      box-sizing: border-box;
      margin-bottom: 20px;
      outline: none;
    }
    input[type="password"]:focus {
      border-color: #38bdf8;
      box-shadow: 0 0 0 2px rgba(56, 189, 248, 0.2);
    }
    button {
      width: 100%;
      background: #0284c7;
      color: #ffffff;
      border: none;
      border-radius: 8px;
      padding: 12px;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.2s;
    }
    button:hover {
      background: #0369a1;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="header">
      <img src="/favicon.svg" alt="Logo" class="logo">
      <h1>Connect Knowledge Base</h1>
      <p>Enter your deployment API Token to authorize access to your private search MCP interface.</p>
    </div>
    ${params.error ? `<div class="error">${htmlEscape(params.error)}</div>` : ""}
    <form method="POST" action="${htmlEscape(params.origin)}/oauth/authorize?response_type=code&client_id=${encodeURIComponent(params.clientId)}&redirect_uri=${encodeURIComponent(params.redirectUri)}&state=${encodeURIComponent(params.state || "")}&code_challenge=${encodeURIComponent(params.codeChallenge || "")}&code_challenge_method=${encodeURIComponent(params.codeChallengeMethod || "")}&resource=${encodeURIComponent(params.resource || "")}">
      <label for="api_token">Deployment API Token</label>
      <input type="password" id="api_token" name="api_token" required placeholder="Enter API_TOKEN" autofocus autocomplete="current-password">
      <button type="submit">Approve Access</button>
    </form>
  </div>
</body>
</html>`;
}

const defaultApp: Hono = createApp();
export default defaultApp;
