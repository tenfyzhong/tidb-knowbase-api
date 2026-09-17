import type { IncomingMessage, ServerResponse } from "node:http";
import defaultApp from "../src/app.js";

export const config = {
  api: {
    bodyParser: false
  }
};

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const protocol = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost";
  const url = `${protocol}://${host}${req.url || "/"}`;

  let body: Buffer | undefined;
  if (!["GET", "HEAD"].includes(req.method || "GET")) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    if (chunks.length > 0) {
      body = Buffer.concat(chunks);
    }
  }

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(key, item);
      }
    } else {
      headers.set(key, value);
    }
  }

  const webRequest = new Request(url, {
    method: req.method || "GET",
    headers,
    body
  });

  const webResponse = await defaultApp.fetch(webRequest);

  if (webResponse.body) {
    const reader = webResponse.body.getReader();
    const flushable = res as { flush?: () => void };
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
        if (typeof flushable.flush === "function") {
          flushable.flush();
        }
      }
    } finally {
      res.end();
    }
  } else {
    res.end();
  }
}
