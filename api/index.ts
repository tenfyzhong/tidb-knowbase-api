import type { IncomingMessage, ServerResponse } from "node:http";
import { handle } from "@hono/node-server/vercel";
import defaultApp from "../src/app.js";

const nodeListener = handle(defaultApp);

interface ExtendedRequest extends IncomingMessage {
  body?: unknown;
  rawBody?: Buffer;
}

export default async function handler(req: ExtendedRequest, res: ServerResponse): Promise<void> {
  if (!["GET", "HEAD"].includes(req.method || "GET") && !req.rawBody) {
    if (req.body !== undefined && req.body !== null) {
      if (Buffer.isBuffer(req.body)) {
        req.rawBody = req.body;
      } else if (typeof req.body === "string") {
        req.rawBody = Buffer.from(req.body);
      } else {
        req.rawBody = Buffer.from(JSON.stringify(req.body));
      }
    } else {
      try {
        const chunks: Buffer[] = [];
        const readStream = async () => {
          for await (const chunk of req) {
            chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
          }
        };
        const timeout = new Promise((resolve) => setTimeout(resolve, 500));
        await Promise.race([readStream(), timeout]);
        if (chunks.length > 0) {
          req.rawBody = Buffer.concat(chunks);
        }
      } catch {
        // ignore stream read error
      }
    }
  }

  return (nodeListener as unknown as (req: IncomingMessage, res: ServerResponse) => Promise<void>)(req, res);
}
