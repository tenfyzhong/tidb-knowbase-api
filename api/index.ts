import { handle } from "hono/vercel";
import defaultApp from "../src/app.js";

const handler = handle(defaultApp);

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
export const OPTIONS = handler;

export default handler;
