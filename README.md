# tidb-knowbase-api

TiDB Cloud Starter Knowledge Base Search & Model Context Protocol (MCP) Server deployed on Vercel.

## Features

- **TiDB Vector Search**: Direct high-performance semantic search using TiDB's native `VECTOR` column and `VEC_COSINE_DISTANCE` function.
- **Stateless Remote MCP Server**: Remote Streamable HTTP / JSON-RPC 2.0 endpoint at `/mcp` exposing the `search_knowledge_base` tool for AI agents and chat clients.
- **Dual Authentication**:
  - Direct Bearer Token (`Authorization: Bearer <API_TOKEN>`) for quick setup in tools like Cursor, Claude Desktop, and CLI scripts.
  - Full OAuth 2.1 with PKCE S256, dynamic client registration, authorization code grants, and rotating refresh tokens for ChatGPT and Claude Code.
- **Vercel Serverless Ready**: Designed for zero-cold-start, serverless deployment on Vercel's free Hobby tier with `@hono/node-server/vercel`.
- **OpenAPI 3.1 Compatibility**: Includes `/openapi.json` for Custom GPT Actions.
- **100% Free Tier Architecture**: Runs within Vercel's free tier and TiDB Cloud Serverless Starter (free 5 GiB storage, 50M Request Units/month) paired with free embedding models.

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
      "text": "TiDB supports vector search with VEC_COSINE_DISTANCE...",
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
- `POST /vectors/upsert`: Upsert document chunks and embeddings.
- `POST /vectors/delete`: Delete vectors by ID list.
- `POST /vectors/clear`: Clear vectors for a source (`?source=notes`) or all sources.
- `GET /sync-state/:source` & `PUT /sync-state/:source`: Read or save incremental sync state.

---

## Connecting MCP Clients

### 1. Direct Token Authentication (Claude Desktop, Cursor, Oh My Pi)

Configure the MCP server with your deployed URL and `API_TOKEN`:

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

1. **Install Vercel CLI**:
   ```bash
   npm install -g vercel
   ```

2. **Configure Environment Variables in Vercel Project Settings**:

   | Variable | Description | Example |
   |---|---|---|
   | `API_TOKEN` | Administrative and OAuth approval token | `your-secret-token` |
   | `TIDB_DATABASE_URL` | TiDB Cloud Starter connection URL | `mysql://user:pass@gateway.tidbcloud.com:4000/test?ssl={"minVersion":"TLSv1.2"}` |
   | `EMBEDDING_PROVIDER` | `openai`, `huggingface`, `gemini`, or `mock` | `openai` |
   | `EMBEDDING_API_KEY` | API key for embedding provider | `sk-...` |
   | `EMBEDDING_BASE_URL` | Base URL for OpenAI-compatible embeddings | `https://api.siliconflow.cn/v1` |
   | `EMBEDDING_MODEL` | Embedding model identifier | `BAAI/bge-m3` |
   | `EMBEDDING_DIMENSION` | Vector dimension size | `1024` |

3. **Deploy**:
   ```bash
   vercel --prod
   ```

## Local Development

```bash
API_TOKEN="dev-token" \
TIDB_DATABASE_URL="mysql://root@127.0.0.1:4000/test" \
EMBEDDING_PROVIDER="mock" \
pnpm start
```

## License

This project is licensed under the [MIT License](LICENSE).
