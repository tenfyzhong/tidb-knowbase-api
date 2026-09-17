import { describe, it, expect, beforeAll } from "vitest";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";

process.env.API_TOKEN = "test-secret-token";
process.env.TIDB_DATABASE_URL = "mysql://root:pass@localhost:4000/test";

import handler from "../api/index.js";
function createMockReq(options: {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
}): IncomingMessage {
  const stream = new Readable();
  if (options.body) {
    stream.push(options.body);
  }
  stream.push(null);

  const req = stream as unknown as IncomingMessage;
  req.method = options.method;
  req.url = options.url;
  req.headers = {
    host: "localhost:3000",
    "x-forwarded-proto": "https",
    ...(options.headers || {})
  };
  return req;
}

function createMockRes(): {
  res: ServerResponse;
  getStatusCode: () => number;
  getHeaders: () => Record<string, string>;
  getBody: () => string;
} {
  let statusCode = 200;
  const headers: Record<string, string> = {};
  const chunks: Buffer[] = [];

  const res = {
    get statusCode() {
      return statusCode;
    },
    set statusCode(val: number) {
      statusCode = val;
    },
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value;
    },
    write(chunk: unknown) {
      if (typeof chunk === "string") {
        chunks.push(Buffer.from(chunk));
      } else if (Buffer.isBuffer(chunk)) {
        chunks.push(chunk);
      } else if (chunk instanceof Uint8Array) {
        chunks.push(Buffer.from(chunk));
      }
      return true;
    },
    end(chunk?: unknown) {
      if (chunk) {
        this.write(chunk);
      }
    }
  } as unknown as ServerResponse;

  return {
    res,
    getStatusCode: () => statusCode,
    getHeaders: () => headers,
    getBody: () => Buffer.concat(chunks).toString("utf-8")
  };
}

describe("Serverless Bridge (api/index.ts)", () => {
  it("should handle GET /openapi.json via serverless handler", async () => {
    const req = createMockReq({ method: "GET", url: "/openapi.json" });
    const { res, getStatusCode, getBody } = createMockRes();

    await handler(req, res);
    expect(getStatusCode()).toBe(200);
    expect(getBody()).toContain('"openapi":"3.1.0"');
  });

  it("should handle POST request with body without hanging", async () => {
    const req = createMockReq({
      method: "POST",
      url: "/oauth/register",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Mock Client",
        redirect_uris: ["http://127.0.0.1:8080/callback"]
      })
    });
    const { res, getStatusCode, getBody } = createMockRes();

    await handler(req, res);
    expect(getStatusCode()).toBe(200);
    const parsed = JSON.parse(getBody());
    expect(parsed.client_id).toBeDefined();
    expect(parsed.client_name).toBe("Mock Client");
  });

  it("should handle POST request when req.body is pre-parsed by Vercel runtime", async () => {
    const req = createMockReq({
      method: "POST",
      url: "/oauth/register",
      headers: { "content-type": "application/json" }
    });
    // Simulate Vercel runtime pre-parsing req.body
    (req as unknown as { body: unknown; readableEnded: boolean }).body = {
      client_name: "Pre-parsed Client",
      redirect_uris: ["http://127.0.0.1:8080/callback"]
    };

    const { res, getStatusCode, getBody } = createMockRes();
    await handler(req, res);
    expect(getStatusCode()).toBe(200);
    const parsed = JSON.parse(getBody());
    expect(parsed.client_id).toBeDefined();
    expect(parsed.client_name).toBe("Pre-parsed Client");
  });
});
