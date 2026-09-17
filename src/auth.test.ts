import { describe, it, expect } from "vitest";
import {
  isLoopbackRedirectUri,
  parseOAuthRedirectUri,
  redirectUriMatches,
  createPkceChallenge,
  signOAuthValue,
  verifyOAuthValue
} from "./auth.js";

describe("auth", () => {
  describe("loopback and redirect URIs", () => {
    it("should recognize loopback redirect URIs", () => {
      expect(isLoopbackRedirectUri(new URL("http://localhost:8080/callback"))).toBe(true);
      expect(isLoopbackRedirectUri(new URL("http://127.0.0.1:3000/oauth"))).toBe(true);
      expect(isLoopbackRedirectUri(new URL("http://[::1]:9999/cb"))).toBe(true);
      expect(isLoopbackRedirectUri(new URL("http://example.com/callback"))).toBe(false);
      expect(isLoopbackRedirectUri(new URL("https://example.com/callback"))).toBe(false);
    });

    it("should parse valid OAuth redirect URIs", () => {
      expect(parseOAuthRedirectUri("https://app.example.com/callback")).not.toBeNull();
      expect(parseOAuthRedirectUri("http://localhost:5000/cb")).not.toBeNull();
      expect(parseOAuthRedirectUri("http://example.com/cb")).toBeNull(); // http non-loopback rejected
      expect(parseOAuthRedirectUri("https://user:pass@example.com/cb")).toBeNull(); // credentials rejected
      expect(parseOAuthRedirectUri("not a url")).toBeNull();
    });

    it("should match redirect URIs", () => {
      expect(
        redirectUriMatches("https://app.example.com/cb", "https://app.example.com/cb")
      ).toBe(true);

      // Loopback port variation is allowed for dynamic ephemeral ports
      expect(
        redirectUriMatches("http://localhost:8000/callback", "http://localhost:9999/callback")
      ).toBe(true);

      expect(
        redirectUriMatches("http://localhost:8000/callback", "http://localhost:8000/different")
      ).toBe(false);
    });
  });

  describe("PKCE challenge", () => {
    it("should compute base64url SHA-256 PKCE challenge", async () => {
      const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
      const challenge = await createPkceChallenge(verifier);
      expect(challenge).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    });
  });

  describe("sign and verify OAuth values", () => {
    const secret = "super-secret-token-key-1234567890";

    it("should sign and verify arbitrary payloads", async () => {
      const payload = { userId: "user-123", role: "admin", exp: 123456789 };
      const signed = await signOAuthValue(secret, "kb_test_", payload);

      expect(signed).toMatch(/^kb_test_/);
      const verified = await verifyOAuthValue<typeof payload>(secret, "kb_test_", signed);
      expect(verified).toEqual(payload);
    });

    it("should reject tampered tokens", async () => {
      const payload = { role: "user" };
      const signed = await signOAuthValue(secret, "kb_test_", payload);
      const tampered = signed.slice(0, -5) + "abcde";

      const verified = await verifyOAuthValue(secret, "kb_test_", tampered);
      expect(verified).toBeNull();
    });

    it("should reject token with incorrect prefix", async () => {
      const payload = { role: "user" };
      const signed = await signOAuthValue(secret, "kb_test_", payload);

      const verified = await verifyOAuthValue(secret, "other_prefix_", signed);
      expect(verified).toBeNull();
    });

    it("should reject token signed with different secret", async () => {
      const payload = { role: "user" };
      const signed = await signOAuthValue("secret-1", "kb_test_", payload);

      const verified = await verifyOAuthValue("secret-2", "kb_test_", signed);
      expect(verified).toBeNull();
    });
  });
});
