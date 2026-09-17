import { describe, it, expect } from "vitest";
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
  const stream = Readable.from(options.body ? [Buffer.from(options.body)] : []);
  const rawHeaders: string[] = [];
  const headersObj: Record<string, string> = {
    host: "localhost:3000",
    "x-forwarded-proto": "https",
    ...(options.headers || {})
  };
  for (const [k, v] of Object.entries(headersObj)) {
    rawHeaders.push(k, v);
  }
  const req = stream as unknown as IncomingMessage;
  req.method = options.method;
  req.url = options.url;
  req.rawHeaders = rawHeaders;
  req.headers = headersObj;
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
    getHeader(name: string) {
      return headers[name.toLowerCase()];
    },
    writeHead(code: number, h?: Record<string, string>) {
      statusCode = code;
      if (h) {
        for (const [k, v] of Object.entries(h)) {
          headers[k.toLowerCase()] = String(v);
        }
      }
      return this;
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
    },
    on() {
      return this;
    },
    once() {
      return this;
    },
    emit() {
      return true;
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
  it("should handle GET /openapi.json", async () => {
    const req = createMockReq({ method: "GET", url: "/openapi.json" });
    const { res, getStatusCode, getBody } = createMockRes();

    await handler(req, res);
    expect(getStatusCode()).toBe(200);
    expect(getBody()).toContain('"openapi":"3.1.0"');
  });

  it("should handle POST /oauth/register with stream body", async () => {
    const req = createMockReq({
      method: "POST",
      url: "/oauth/register",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Stream Client",
        redirect_uris: ["http://127.0.0.1:8080/callback"]
      })
    });
    const { res, getStatusCode, getBody } = createMockRes();

    await handler(req, res);
    expect(getStatusCode()).toBe(201);
    const parsed = JSON.parse(getBody());
    expect(parsed.client_id).toBeDefined();
    expect(parsed.client_name).toBe("Stream Client");
  });

  it("should handle POST /oauth/register with pre-parsed req.body", async () => {
    const req = createMockReq({
      method: "POST",
      url: "/oauth/register",
      headers: { "content-type": "application/json" }
    });
    (req as unknown as { body: unknown }).body = {
      client_name: "Pre-parsed Client",
      redirect_uris: ["http://127.0.0.1:8080/callback"]
    };

    const { res, getStatusCode, getBody } = createMockRes();
    await handler(req, res);
    expect(getStatusCode()).toBe(201);
    const parsed = JSON.parse(getBody());
    expect(parsed.client_id).toBeDefined();
    expect(parsed.client_name).toBe("Pre-parsed Client");
  });

  it("should handle POST /oauth/authorize with pre-parsed urlencoded req.body", async () => {
    // First register client
    const regReq = createMockReq({
      method: "POST",
      url: "/oauth/register",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Authorize Test Client",
        redirect_uris: ["http://127.0.0.1:8080/callback"]
      })
    });
    const regMock = createMockRes();
    await handler(regReq, regMock.res);
    expect(regMock.getStatusCode()).toBe(201);
    const { client_id: clientId } = JSON.parse(regMock.getBody());

    // Submit authorization form with urlencoded body
    const authReq = createMockReq({
      method: "POST",
      url: `/oauth/authorize?response_type=code&client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent("http://127.0.0.1:8080/callback")}`,
      headers: { "content-type": "application/x-www-form-urlencoded" }
    });
    (authReq as unknown as { body: unknown }).body = {
      api_token: "test-secret-token "
    };

    const authMock = createMockRes();
    await handler(authReq, authMock.res);
    expect(authMock.getStatusCode()).toBe(302);
    expect(authMock.getHeaders()["location"]).toContain("http://127.0.0.1:8080/callback?code=");
  });
});
