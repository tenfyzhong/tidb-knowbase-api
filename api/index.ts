import { handle } from "@hono/node-server/vercel";
import defaultApp from "../src/app.js";

export default handle(defaultApp);
