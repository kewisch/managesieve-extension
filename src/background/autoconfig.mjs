import {
  OPEN_CLIENT_ID,
  discoverOAuthEndpoints,
  discoverProtectedResourceMetadata,
  getPreferredOAuthScope,
  parseResourceMetadataFromAuthenticateHeader,
} from "./oauth-client.mjs";
import { ProviderError } from "./provider-error.mjs";
import { normalizeJmapSessionUrl } from "./server-address.mjs";

const TCP_AUTOCONFIG_PORT = 4190;
const TCP_SECURITY_PROBE_ORDER = ["tls", "starttls"];
const HARDCODED_SERVER_CONFIGS_URL = new URL("./server-configs.json", import.meta.url);
const URL_SCHEME_PATTERN = /^[a-z][a-z\d+.-]*:/i;
const UNSAFE_HARDCODED_CONFIG_FIELDS = new Set([
  "oauthExpiresAt",
  "oauthRefreshToken",
  "password",
  "token",
  "username",
]);

export async function discoverJmapAutoconfig({
  serverAddress,
  account = null,
  hardcodedConfigs = [],
  fetchImpl = fetch,
}) {
  const hardcodedConfig = findHardcodedServerConfig({
    serverAddress,
    account,
    hardcodedConfigs,
  });
  if (hardcodedConfig) {
    return {
      available: true,
      config: hardcodedConfig,
      hardcoded: true,
    };
  }

  const sessionUrl = normalizeJmapSessionUrl(serverAddress);
  if (!sessionUrl) {
    throw new ProviderError("missingServerAddress", "A server address is required.");
  }

  let response = null;
  try {
    response = await fetchImpl(sessionUrl, { method: "GET" });
  } catch (error) {
    return unavailableJmapResult(sessionUrl, error);
  }

  const discoveredSessionUrl = response.url || sessionUrl;
  if (isJmapUnavailable(response)) {
    return unavailableJmapResult(discoveredSessionUrl);
  }
  if (!response.ok && response.status != 401 && response.status != 403) {
    throw new ProviderError("jmapAutoconfigFailed", `JMAP discovery failed with HTTP ${response.status}.`, {
      status: response.status,
    });
  }

  try {
    const discovery = await discoverOAuthForJmap({
      sessionUrl: discoveredSessionUrl,
      authenticateHeader: response.headers.get("WWW-Authenticate") || "",
      fetchImpl,
    });

    return {
      available: true,
      config: {
        provider: "jmap",
        authType: "oauth",
        sessionUrl: discoveredSessionUrl,
        ...oauthConfigFromEndpoints({
          oauthEndpoints: discovery.oauthEndpoints,
          resourceMetadata: discovery.resourceMetadata,
        }),
      },
      resourceMetadata: discovery.resourceMetadata,
      oauthEndpoints: discovery.oauthEndpoints,
    };
  } catch (error) {
    throw new ProviderError("oauthDiscoveryFailed", error.message || "OAuth metadata discovery failed.", {
      config: {
        provider: "jmap",
        authType: "oauth",
        sessionUrl: discoveredSessionUrl,
        ...oauthConfigFromEndpoints({
          oauthEndpoints: error.details?.oauthEndpoints,
          resourceMetadata: error.details?.resourceMetadata,
        }),
      },
    });
  }
}

export async function loadHardcodedServerConfigs({
  configUrl = HARDCODED_SERVER_CONFIGS_URL,
  fetchImpl = fetch,
} = {}) {
  const response = await fetchImpl(configUrl);
  if (!response.ok) {
    throw new ProviderError("hardcodedConfigLoadFailed", `Hardcoded server configuration failed with HTTP ${response.status}.`, {
      status: response.status,
    });
  }

  const configs = await response.json();
  if (!Array.isArray(configs)) {
    throw new ProviderError("invalidHardcodedConfig", "Hardcoded server configuration must be a JSON array.");
  }

  return configs;
}

export function findHardcodedServerConfig({
  serverAddress,
  account = null,
  hardcodedConfigs = [],
}) {
  const candidates = getServerConfigMatchCandidates(serverAddress, account);
  for (const entry of hardcodedConfigs) {
    if (!entry?.config || !Array.isArray(entry.domains)) {
      continue;
    }

    const aliases = entry.domains.map(normalizeDomain).filter(Boolean);
    if (aliases.some(alias => candidates.some(candidate => domainMatches(candidate, alias)))) {
      return sanitizeHardcodedConfig(entry.config);
    }
  }

  return null;
}

async function discoverOAuthForJmap({
  sessionUrl,
  authenticateHeader,
  fetchImpl,
}) {
  try {
    const resourceMetadata = await discoverProtectedResourceMetadata({
      resourceUrl: sessionUrl,
      metadataUrl: parseResourceMetadataFromAuthenticateHeader(authenticateHeader),
      fetchImpl,
    });
    return {
      resourceMetadata,
      oauthEndpoints: await discoverOAuthEndpoints({
        issuerUrl: resourceMetadata.authorizationServers[0],
        fetchImpl,
      }),
    };
  } catch (protectedResourceError) {
    return {
      resourceMetadata: null,
      oauthEndpoints: await discoverOAuthEndpoints({
        issuerUrl: new URL(sessionUrl).origin,
        fetchImpl,
      }),
      protectedResourceError,
    };
  }
}

function getServerConfigMatchCandidates(serverAddress, account) {
  const candidates = new Set();
  const serverHost = normalizeDomain(extractHost(serverAddress));
  if (serverHost) {
    candidates.add(serverHost);
  }

  for (const identity of account?.identities || []) {
    const domain = normalizeDomain(identity.email?.split("@").pop() || "");
    if (domain) {
      candidates.add(domain);
    }
  }

  return [...candidates];
}

function extractHost(value) {
  const trimmedValue = value?.trim() || "";
  if (!trimmedValue) {
    return "";
  }

  try {
    return new URL(URL_SCHEME_PATTERN.test(trimmedValue) ? trimmedValue : `https://${trimmedValue}`).hostname;
  } catch {
    return "";
  }
}

function normalizeDomain(value) {
  return (value || "").trim().toLowerCase().replace(/\.$/, "");
}

function domainMatches(candidate, alias) {
  return candidate == alias || candidate.endsWith(`.${alias}`);
}

function sanitizeHardcodedConfig(config) {
  return Object.fromEntries(
    Object.entries(config).filter(([key]) => !UNSAFE_HARDCODED_CONFIG_FIELDS.has(key))
  );
}

export async function probeTcpAutoconfig({
  provider,
  config,
}) {
  const failures = [];

  for (const tcpSecurity of TCP_SECURITY_PROBE_ORDER) {
    const attemptConfig = {
      ...config,
      provider: "tcp",
      authType: "basic",
      tcpPort: Number(config.tcpPort || TCP_AUTOCONFIG_PORT),
      tcpSecurity,
    };
    let connection = null;
    try {
      connection = await provider.discover(attemptConfig);
      const scripts = await provider.listScripts(connection);
      return {
        config: attemptConfig,
        scripts: scripts.scripts || [],
      };
    } catch (error) {
      failures.push({
        tcpSecurity,
        code: error.code || "unexpectedError",
        message: error.message || String(error),
      });
    } finally {
      if (connection) {
        await provider.closeConnection?.(connection);
      }
    }
  }

  throw new ProviderError("tcpAutoconfigFailed", "TCP ManageSieve autodetection failed.", {
    failures,
  });
}

function unavailableJmapResult(sessionUrl, error = null) {
  return {
    available: false,
    config: {
      provider: "jmap",
      authType: "oauth",
      sessionUrl,
    },
    error,
  };
}

function isJmapUnavailable(response) {
  return response.status == 404 || response.status == 410;
}

function oauthConfigFromEndpoints({
  oauthEndpoints,
  resourceMetadata = null,
}) {
  if (!oauthEndpoints) {
    return {};
  }

  return {
    oauthIssuerUrl: oauthEndpoints.issuer,
    oauthAuthorizationUrl: oauthEndpoints.authorizationUrl,
    oauthClientId: OPEN_CLIENT_ID,
    oauthTokenUrl: oauthEndpoints.tokenUrl,
    oauthScope: getPreferredOAuthScope({
      resourceScopesSupported: resourceMetadata?.scopesSupported || [],
      authorizationScopesSupported: oauthEndpoints.scopesSupported,
    }),
  };
}
