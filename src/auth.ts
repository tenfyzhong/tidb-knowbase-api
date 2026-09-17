import type { Context } from "hono";

export const MCP_SCOPE = "search:read";
export const ACCESS_TOKEN_TTL_SECONDS = 3600;
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
export const AUTHORIZATION_CODE_TTL_SECONDS = 10 * 60;

export interface OAuthClient {
  id: string;
  redirectUris: string[];
  createdAt: number;
}

export interface AuthorizationCodeGrant {
  id: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  resource: string;
  codeChallenge?: string;
  expiresAt: number;
}

export interface OAuthTokenGrant {
  id: string;
  clientId: string;
  scope: string;
  resource: string;
  expiresAt: number;
}

export function isLoopbackRedirectUri(redirectUri: URL): boolean {
  return (
    redirectUri.protocol === "http:" &&
    (redirectUri.hostname === "localhost" ||
      redirectUri.hostname === "127.0.0.1" ||
      redirectUri.hostname === "[::1]")
  );
}

export function parseOAuthRedirectUri(value: string): URL | null {
  try {
    const redirectUri = new URL(value);
    if (
      redirectUri.username ||
      redirectUri.password ||
      redirectUri.hash ||
      (redirectUri.protocol !== "https:" && !isLoopbackRedirectUri(redirectUri))
    ) {
      return null;
    }
    return redirectUri;
  } catch {
    return null;
  }
}

export function redirectUriMatches(registeredValue: string, requestedValue: string): boolean {
  if (registeredValue === requestedValue) {
    return true;
  }

  const registered = parseOAuthRedirectUri(registeredValue);
  const requested = parseOAuthRedirectUri(requestedValue);
  if (
    !registered ||
    !requested ||
    !isLoopbackRedirectUri(registered) ||
    !isLoopbackRedirectUri(requested)
  ) {
    return false;
  }

  return (
    registered.protocol === requested.protocol &&
    registered.hostname === requested.hostname &&
    registered.pathname === requested.pathname &&
    registered.search === requested.search
  );
}

function base64Url(bytes: ArrayBuffer): string {
  return Buffer.from(bytes).toString("base64url");
}

function base64UrlText(value: string): string {
  return Buffer.from(value, "utf-8").toString("base64url");
}

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const buf = Buffer.from(value, "base64url");
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

export async function signOAuthValue<T>(
  secret: string,
  prefix: string,
  value: T
): Promise<string> {
  const payload = base64UrlText(JSON.stringify(value));
  const signedValue = `${prefix}${payload}`;
  const signature = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret),
    new TextEncoder().encode(signedValue)
  );
  return `${signedValue}.${base64Url(signature)}`;
}

export async function verifyOAuthValue<T>(
  secret: string,
  prefix: string,
  value: string
): Promise<T | null> {
  if (!value.startsWith(prefix)) {
    return null;
  }
  const separator = value.lastIndexOf(".");
  if (separator <= prefix.length) {
    return null;
  }

  const signedValue = value.slice(0, separator);
  const signature = value.slice(separator + 1);
  try {
    const valid = await crypto.subtle.verify(
      "HMAC",
      await hmacKey(secret),
      decodeBase64Url(signature),
      new TextEncoder().encode(signedValue)
    );
    if (!valid) {
      return null;
    }
    const payload = signedValue.slice(prefix.length);
    return JSON.parse(
      new TextDecoder().decode(decodeBase64Url(payload))
    ) as T;
  } catch {
    return null;
  }
}

export async function createPkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier)
  );
  return base64Url(digest);
}

export function getBearerToken(c: Context): string | null {
  const authHeader = c.req.header("Authorization");
  if (authHeader) {
    if (authHeader.startsWith("Bearer ")) {
      return authHeader.slice(7).trim() || null;
    }
    return authHeader.trim() || null;
  }

  const xToken = c.req.header("X-API-Token") || c.req.header("x-api-token");
  if (xToken) {
    return xToken.trim() || null;
  }

  const queryToken =
    c.req.query("token") ||
    c.req.query("api_token") ||
    c.req.query("apiKey") ||
    c.req.query("key");
  if (queryToken) {
    return queryToken.trim() || null;
  }

  return null;
}

export function isApiTokenAuthorized(c: Context, apiToken: string): boolean {
  const token = getBearerToken(c);
  return Boolean(token && token.trim() === apiToken.trim());
}

export async function getOAuthTokenGrant(
  c: Context,
  apiToken: string,
  expectedResource?: string
): Promise<OAuthTokenGrant | null> {
  const token = getBearerToken(c);
  if (!token) {
    return null;
  }

  const grant = await verifyOAuthValue<OAuthTokenGrant>(apiToken, "kb_at_", token);
  if (!grant || grant.expiresAt <= Date.now()) {
    return null;
  }
  if (expectedResource && grant.resource !== expectedResource) {
    const normalize = (r: string) => r.replace(/^https?:\/\//, "").replace(/\/+$/, "");
    if (normalize(grant.resource) !== normalize(expectedResource)) {
      return null;
    }
  }
  if (!grant.scope.split(/\s+/).some((scope) => scope === MCP_SCOPE || scope === "read")) {
    return null;
  }
  return grant;
}

/**
 * Returns true if request is authorized either by direct API_TOKEN or a valid OAuth grant.
 */
export async function isMcpAuthorized(
  c: Context,
  apiToken: string,
  expectedResource?: string
): Promise<boolean> {
  const token = getBearerToken(c);
  if (!token) {
    return false;
  }

  // 1. Direct Bearer API_TOKEN authorization
  if (token && token.trim() === apiToken.trim()) {
    return true;
  }

  // 2. OAuth access token authorization
  const grant = await getOAuthTokenGrant(c, apiToken, expectedResource);
  return Boolean(grant);
}

export function htmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
