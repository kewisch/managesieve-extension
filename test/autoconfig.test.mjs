import assert from "node:assert/strict";
import test from "node:test";

import {
  discoverJmapAutoconfig,
  findHardcodedServerConfig,
  probeTcpAutoconfig,
} from "../src/background/autoconfig.mjs";
import { ProviderError } from "../src/background/provider-error.mjs";

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json", ...(init.headers || {}) },
  });
}

test("JMAP autoconfig uses matching hardcoded server configurations before fetching metadata", async () => {
  let fetched = false;
  const result = await discoverJmapAutoconfig({
    serverAddress: "mail.thundermail.com",
    hardcodedConfigs: [{
      domains: ["thundermail.com", "tb.pro"],
      config: {
        provider: "jmap",
        authType: "oauth",
        sessionUrl: "https://mail.thundermail.com/.well-known/jmap",
        oauthIssuerUrl: "https://auth.tb.pro/realms/tbpro",
        oauthAuthorizationUrl: "https://auth.tb.pro/realms/tbpro/protocol/openid-connect/auth",
        oauthTokenUrl: "https://auth.tb.pro/realms/tbpro/protocol/openid-connect/token",
        oauthClientId: "desktop",
        oauthScope: "openid email offline_access",
      },
    }],
    fetchImpl: async () => {
      fetched = true;
      return new Response("", { status: 404 });
    },
  });

  assert.equal(fetched, false);
  assert.equal(result.available, true);
  assert.equal(result.hardcoded, true);
  assert.deepEqual(result.config, {
    provider: "jmap",
    authType: "oauth",
    sessionUrl: "https://mail.thundermail.com/.well-known/jmap",
    oauthIssuerUrl: "https://auth.tb.pro/realms/tbpro",
    oauthAuthorizationUrl: "https://auth.tb.pro/realms/tbpro/protocol/openid-connect/auth",
    oauthTokenUrl: "https://auth.tb.pro/realms/tbpro/protocol/openid-connect/token",
    oauthClientId: "desktop",
    oauthScope: "openid email offline_access",
  });
});

test("hardcoded server configuration matches account identity domains and strips secrets", () => {
  assert.deepEqual(findHardcodedServerConfig({
    serverAddress: "unrelated.example.net",
    account: {
      identities: [{ email: "user@tb.pro" }],
    },
    hardcodedConfigs: [{
      domains: ["thundermail.com", "tb.pro"],
      config: {
        provider: "jmap",
        authType: "oauth",
        sessionUrl: "https://mail.thundermail.com/.well-known/jmap",
        token: "not-stored",
        username: "not-stored",
      },
    }],
  }), {
    provider: "jmap",
    authType: "oauth",
    sessionUrl: "https://mail.thundermail.com/.well-known/jmap",
  });
});

test("JMAP autoconfig discovers OAuth fields from protected resource metadata", async () => {
  const calls = [];
  const result = await discoverJmapAutoconfig({
    serverAddress: "api.example.net",
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), redirect: options.redirect || "" });
      if (url == "https://api.example.net/.well-known/jmap") {
        return new Response("", {
          status: 401,
          headers: {
            "WWW-Authenticate": 'Bearer resource_metadata="https://api.example.net/.well-known/oauth-protected-resource/jmap/session"',
          },
        });
      }
      if (url == "https://api.example.net/.well-known/oauth-protected-resource/jmap/session") {
        return jsonResponse({
          resource: "https://api.example.net/.well-known/jmap",
          authorization_servers: ["https://auth.example.net/acme"],
          scopes_supported: ["urn:ietf:params:oauth:scope:mail"],
        });
      }
      assert.equal(url, "https://auth.example.net/.well-known/oauth-authorization-server/acme");
      return jsonResponse({
        issuer: "https://auth.example.net/acme",
        authorization_endpoint: "https://auth.example.net/oauth/authorize",
        token_endpoint: "https://auth.example.net/oauth/token",
        registration_endpoint: "https://auth.example.net/oauth/register",
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        token_endpoint_auth_methods_supported: ["none"],
        code_challenge_methods_supported: ["S256"],
        authorization_response_iss_parameter_supported: true,
        scopes_supported: ["urn:ietf:params:oauth:scope:mail", "offline_access"],
      });
    },
  });

  assert.equal(result.available, true);
  assert.deepEqual(result.config, {
    provider: "jmap",
    authType: "oauth",
    sessionUrl: "https://api.example.net/.well-known/jmap",
    oauthIssuerUrl: "https://auth.example.net/acme",
    oauthAuthorizationUrl: "https://auth.example.net/oauth/authorize",
    oauthClientId: "open",
    oauthTokenUrl: "https://auth.example.net/oauth/token",
    oauthScope: "urn:ietf:params:oauth:scope:mail offline_access",
  });
  assert.equal(calls.at(-1).redirect, "manual");
});

test("JMAP autoconfig reports unavailable when the well-known endpoint is missing", async () => {
  const result = await discoverJmapAutoconfig({
    serverAddress: "mail.example.net",
    fetchImpl: async () => new Response("", { status: 404 }),
  });

  assert.equal(result.available, false);
  assert.equal(result.config.sessionUrl, "https://mail.example.net/.well-known/jmap");
});

test("JMAP autoconfig falls back to OAuth metadata on the entered server origin", async () => {
  const calls = [];
  const result = await discoverJmapAutoconfig({
    serverAddress: "mail.example.net",
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), redirect: options.redirect || "" });
      if (url == "https://mail.example.net/.well-known/jmap") {
        return new Response("", { status: 401 });
      }
      if (url == "https://mail.example.net/.well-known/oauth-protected-resource/.well-known/jmap") {
        return new Response("", { status: 404 });
      }
      if (url == "https://mail.example.net/.well-known/oauth-authorization-server") {
        return new Response("", { status: 404 });
      }
      assert.equal(url, "https://mail.example.net/.well-known/openid-configuration");
      return jsonResponse({
        issuer: "https://mail.example.net",
        authorization_endpoint: "https://mail.example.net/oauth/authorize",
        token_endpoint: "https://mail.example.net/oauth/token",
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code"],
        token_endpoint_auth_methods_supported: ["none"],
        code_challenge_methods_supported: ["S256"],
        authorization_response_iss_parameter_supported: true,
        scopes_supported: ["urn:ietf:params:oauth:scope:mail"],
      });
    },
  });

  assert.equal(result.available, true);
  assert.equal(result.config.oauthIssuerUrl, "https://mail.example.net");
  assert.equal(result.config.oauthAuthorizationUrl, "https://mail.example.net/oauth/authorize");
  assert.deepEqual(calls.map(call => [call.url, call.redirect]), [
    ["https://mail.example.net/.well-known/jmap", ""],
    ["https://mail.example.net/.well-known/oauth-protected-resource/.well-known/jmap", ""],
    ["https://mail.example.net/.well-known/oauth-authorization-server", "manual"],
    ["https://mail.example.net/.well-known/openid-configuration", "manual"],
  ]);
});

test("JMAP autoconfig includes discovered OAuth endpoints when metadata validation fails", async () => {
  await assert.rejects(
    () => discoverJmapAutoconfig({
      serverAddress: "mail.example.net",
      fetchImpl: async url => {
        if (url == "https://mail.example.net/.well-known/jmap") {
          return new Response("", { status: 401 });
        }
        if (url == "https://mail.example.net/.well-known/oauth-protected-resource/.well-known/jmap") {
          return new Response("", { status: 404 });
        }
        return jsonResponse({
          issuer: "https://mail.example.net",
          authorization_endpoint: "https://mail.example.net/oauth/authorize",
          token_endpoint: "https://mail.example.net/oauth/token",
          registration_endpoint: "https://mail.example.net/oauth/register",
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code"],
          token_endpoint_auth_methods_supported: ["client_secret_basic"],
          code_challenge_methods_supported: ["S256"],
          authorization_response_iss_parameter_supported: true,
          scopes_supported: ["urn:ietf:params:oauth:scope:mail"],
        });
      },
    }),
    error => {
      assert.equal(error.code, "oauthDiscoveryFailed");
      assert.equal(error.message, "OAuth metadata does not support public clients.");
      assert.deepEqual(error.details.config, {
        provider: "jmap",
        authType: "oauth",
        sessionUrl: "https://mail.example.net/.well-known/jmap",
        oauthIssuerUrl: "https://mail.example.net",
        oauthAuthorizationUrl: "https://mail.example.net/oauth/authorize",
        oauthClientId: "open",
        oauthTokenUrl: "https://mail.example.net/oauth/token",
        oauthScope: "urn:ietf:params:oauth:scope:mail",
      });
      return true;
    }
  );
});

test("TCP autoconfig probes implicit TLS before STARTTLS", async () => {
  const attempts = [];
  const provider = {
    async discover(config) {
      attempts.push(config.tcpSecurity);
      if (config.tcpSecurity == "tls") {
        throw new ProviderError("tcpConnectFailed", "TLS failed.");
      }
      return { socketId: "socket-1" };
    },
    async listScripts() {
      return {
        scripts: [{ id: "main", name: "main", isActive: true }],
      };
    },
    async closeConnection(connection) {
      attempts.push(`close:${connection.socketId}`);
    },
  };

  const result = await probeTcpAutoconfig({
    provider,
    config: {
      sessionUrl: "sieve.example.net",
      username: "user",
      password: "pass",
    },
  });

  assert.deepEqual(attempts, ["tls", "starttls", "close:socket-1"]);
  assert.equal(result.config.provider, "tcp");
  assert.equal(result.config.tcpPort, 4190);
  assert.equal(result.config.tcpSecurity, "starttls");
  assert.deepEqual(result.scripts, [{ id: "main", name: "main", isActive: true }]);
});
