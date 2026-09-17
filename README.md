# tidb-knowbase-api

TiDB Cloud Starter Knowledge Base Search & Model Context Protocol (MCP) Server deployed on Vercel with native TiDB Auto Embedding.

## Features

- **Native Auto Embedding Vector Search**: Uses TiDB Cloud's native `VEC_EMBED_COSINE_DISTANCE(embedding, query)` function. Natural language search queries are passed directly to SQL, where TiDB automatically embeds the query and calculates cosine distance—**completely eliminating the need for any external embedding API keys or local ML dependencies on Vercel**.
- **Stateless Remote MCP Server**: Remote Streamable HTTP / JSON-RPC 2.0 endpoint at `/mcp` exposing the `search_knowledge_base` tool for AI agents and chat clients.
- **Enforced TLS Security**: Enforces TLS 1.2+ with certificate validation for all connections to TiDB Cloud Serverless.
- **Dual Authentication**:
  - Direct Bearer Token (`Authorization: Bearer <API_TOKEN>`) for quick setup in tools like Cursor, Claude Desktop, and CLI scripts.
  - Full OAuth 2.1 with PKCE S256, dynamic client registration, authorization code grants, and rotating refresh tokens for ChatGPT and Claude Code.
- **Ultra-Fast Vercel Serverless**: No ML model cold start, lightning-fast response times (< 50ms SQL execution) on Vercel's free Hobby tier.
- **OpenAPI 3.1 Compatibility**: Includes `/openapi.json` for Custom GPT Actions.
- **100% Free Tier Architecture**: Runs within Vercel's free tier and TiDB Cloud Serverless Starter (free 5 GiB storage, 50M Request Units/month) with **zero external API costs**.

## Endpoints

### 1. `POST /mcp`
Remote MCP endpoint exposing the `search_knowledge_base` tool. Supports both OAuth-issued access tokens and direct deployment `API_TOKEN`.

- Supported JSON-RPC methods:
  - `initialize`: Returns server info, protocol version, and capabilities.
  - `ping`: Health check.
  - `tools/list`: Lists available tools (`search_knowledge_base`).
  - `tools/call`: Executes search and returns matched knowledge chunks.

### 2. `POST /search`
REST semantic search endpoint.

- **Request Body**:
```json
{
  "query": "how to configure vector indexing in TiDB",
  "topK": 5,
  "source": "notes"
}
```

- **Response**:
```json
{
  "query": "how to configure vector indexing in TiDB",
  "count": 1,
  "results": [
    {
      "id": "notes:abc1234:0",
      "score": 0.9421,
      "text": "TiDB supports vector search with VEC_EMBED_COSINE_DISTANCE...",
      "source": "notes",
      "path": "docs/tidb-vector.md",
      "title": "TiDB Vector Guide",
      "chunkIndex": 0
    }
  ]
}
```

### 3. `GET /health`
Health check endpoint verifying database connectivity:
```json
{
  "status": "ok",
  "database": "connected"
}
```

### 4. OAuth 2.1 Endpoints
- `GET /.well-known/oauth-protected-resource`: Resource discovery metadata.
- `GET /.well-known/oauth-authorization-server`: Authorization server discovery metadata.
- `POST /oauth/register`: Dynamic client registration.
- `GET|POST /oauth/authorize`: User authorization confirmation page.
- `POST /oauth/token`: Authorization code and refresh token exchange.
- `GET /oauth/verify`: Token validation.

### 5. Vector Management Endpoints
- `POST /vectors/upsert`: Upsert document chunks (TiDB automatically calculates embeddings).
- `POST /vectors/delete`: Delete vectors by ID list.
- `POST /vectors/clear`: Clear vectors for a source (`?source=notes`) or all sources.
- `GET /sync-state/:source` & `PUT /sync-state/:source`: Read or save incremental sync state.

---

## Configuration & Parameters

### 1. Vercel Runtime Environment Variables

Configure these in **Vercel Dashboard -> Project Settings -> Environment Variables**:

| Variable Name | Required | Default | Description | Example |
|---|:---:|:---:|---|---|
| `API_TOKEN` | **Yes** | - | Administrative master key for direct MCP Bearer authentication, OAuth approval, and vector management. | `your-secret-api-token` |
| `TIDB_DATABASE_URL` | **Yes** | - | Connection string for TiDB Cloud Starter. TLS 1.2+ is enforced automatically. | `mysql://<user>:<password>@gateway.tidbcloud.com:4000/test?ssl={"minVersion":"TLSv1.2"}` |
| `TIDB_SSL` | No | `true` | Enforces TLS connection to TiDB Cloud. | `true` |
| `TIDB_SSL_REJECT_UNAUTHORIZED` | No | `true` | Validates server CA certificate against trusted root CAs. | `true` |
| `TIDB_CA` | No | - | Optional custom CA certificate content or path. | - |
| `PORT` | No | `3000` | Port for local standalone server execution. | `3000` |

*(Note: No embedding API keys or model parameters are required. TiDB Cloud automatically executes Auto Embedding in SQL).*

---

### 2. GitHub Actions Workflows & Parameters

In your GitHub repository, navigate to **Settings -> Secrets and variables -> Actions** if you use automated GitHub Actions deployments:

#### `deploy.yml` (Automated Deploy to Vercel)
- **Triggers**: Push tag (`v*`, `[0-9]*`) or manual trigger (`workflow_dispatch`).
- **Required Secrets** (only needed when deploying via GitHub Actions):
  | Secret Name | Required | Description |
  |---|:---:|---|
  | `VERCEL_TOKEN` | **Yes** | Personal Access Token from Vercel Account Settings -> Tokens. |
  | `VERCEL_ORG_ID` | **Yes** | Organization ID generated by `vercel link` in `.vercel/project.json`. |
  | `VERCEL_PROJECT_ID` | **Yes** | Project ID generated by `vercel link` in `.vercel/project.json`. |

*(Note: If you connect your GitHub repository directly within the Vercel Dashboard for Git-triggered deployments, the above GitHub Actions secrets are not needed).*

#### `test.yml` (CI Automated Testing)
- **Triggers**: Push and pull requests to `main`. Executes unit tests (`pnpm test`) and compilation (`pnpm build`). No extra secrets required.

---

## Connecting MCP Clients

`tidb-knowbase-api` supports all standard MCP transport mechanisms:
1. **Streamable HTTP** (`POST /mcp` with optional `GET /mcp` stream and `Mcp-Session-Id` header).
2. **Server-Sent Events (SSE)** (`GET /sse` or `GET /mcp` with `endpoint` discovery).
3. **Full CORS Support**: Enabled for all web and Electron-based clients (WorkBuddy, Cursor, browser extensions).

### 1. Direct Token Authentication

You can supply `API_TOKEN` through any of the following methods:
- **HTTP Header**: `Authorization: Bearer YOUR_API_TOKEN`
- **Custom Header**: `X-API-Token: YOUR_API_TOKEN`
- **URL Query Parameter**: `https://your-domain.vercel.app/mcp?token=YOUR_API_TOKEN` (or `/sse?token=YOUR_API_TOKEN`)

#### WorkBuddy / Cursor / GUI MCP Clients

If your client supports entering a URL directly (with or without headers):
```text
# URL with token in query param (works with all clients):
https://your-domain.vercel.app/mcp?token=YOUR_API_TOKEN

# Or for clients dedicated to SSE transport:
https://your-domain.vercel.app/sse?token=YOUR_API_TOKEN
```
If your client supports custom headers:
```json
{
  "url": "https://your-domain.vercel.app/mcp",
  "headers": {
    "Authorization": "Bearer YOUR_API_TOKEN"
  }
}
```

#### Claude Desktop (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "knowbase": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://your-domain.vercel.app/mcp",
        "--header",
        "Authorization: Bearer YOUR_API_TOKEN"
      ]
    }
  }
}
```

#### Oh My Pi (`~/.omp/agent/mcp.json`)

```json
{
  "mcpServers": {
    "knowbase": {
      "type": "http",
      "url": "https://your-domain.vercel.app/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_API_TOKEN"
      }
    }
  }
}
```

### 2. OAuth 2.1 Dynamic Authentication (ChatGPT, Claude Code)

#### ChatGPT Web Plugins
1. Open **ChatGPT Settings > Security and login**, and enable **Developer mode**.
2. Open **ChatGPT Plugins**, click **Add an MCP server**, and enter:
   ```text
   https://your-domain.vercel.app/mcp
   ```
3. ChatGPT discovers the OAuth endpoints automatically. When prompted, enter your deployment `API_TOKEN` to authorize.

---

## Deployment to Vercel

1. **Option A: Vercel Git Integration (Recommended)**:
   - Import `tidb-knowbase-api` repository in [Vercel Dashboard](https://vercel.com).
   - Add environment variables in **Project Settings -> Environment Variables** (only `API_TOKEN` and `TIDB_DATABASE_URL` are required).
   - Every push to `main` deploys automatically.

2. **Option B: Vercel CLI**:
   ```bash
   npm install -g vercel
   vercel --prod
   ```

## Local Development

```bash
API_TOKEN="dev-token" \
TIDB_DATABASE_URL="mysql://root@127.0.0.1:4000/test" \
pnpm start
```

## License

This project is licensed under the [MIT License](LICENSE).
