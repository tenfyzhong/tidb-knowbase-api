import { serve } from "@hono/node-server";
import defaultApp from "./app.js";

const port = Number(process.env.PORT) || 3000;

console.log(`TiDB Knowledge Base API listening on http://localhost:${port}`);
serve({
  fetch: defaultApp.fetch,
  port
});
