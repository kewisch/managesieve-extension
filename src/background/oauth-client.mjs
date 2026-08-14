export const OPEN_CLIENT_ID = "open";
export const MAIL_OAUTH_SCOPE = "urn:ietf:params:oauth:scope:mail";
export const LEGACY_JMAP_SIEVE_OAUTH_SCOPE = "urn:ietf:params:jmap:core urn:ietf:params:jmap:sieve";
export const DEFAULT_OAUTH_SCOPE = MAIL_OAUTH_SCOPE;
export const OAUTH_CALLBACK_URL = "http://localhost/";
export const OAUTH_CALLBACK_URL_PATTERNS = [
  "http://localhost/*",
  "https://localhost/*",
];
const OAUTH_EXPIRE_GRACE_SECONDS = 60;
const OAUTH_WINDOW_WIDTH = 430;
const OAUTH_WINDOW_HEIGHT = 750;

export function buildAuthorizationUrl({
  authorizationUrl,
  redirectUrl,
  scope,
  state,
  codeChallenge,
  resource,
  clientId = OPEN_CLIENT_ID,
  loginHint = "",
  uiLanguage = "",
}) {
  const url = new URL(authorizationUrl);
  url.searchParams.set("client_id", normalizeClientId(clientId));
  url.searchParams.set("redirect_uri", redirectUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", scope || DEFAULT_OAUTH_SCOPE);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");

  if (resource) {
    url.searchParams.set("resource", resource);
  }
  if (loginHint) {
    url.searchParams.set("login_hint", loginHint);
  }
  if (uiLanguage) {
    url.searchParams.set("hl", uiLanguage);
  }

  return url.toString();
}

export class OAuthWindowFlow {
  constructor({
    callbackUrl = OAUTH_CALLBACK_URL,
    width = OAUTH_WINDOW_WIDTH,
    height = OAUTH_WINDOW_HEIGHT,
  } = {}) {
    this.callbackUrl = callbackUrl;
    this.width = width;
    this.height = height;
  }

  async authorize(config, { titlePreface = "", loginHint = "", endpointMessages = {}, messages = {} } = {}) {
    const endpoints = await resolveOAuthEndpoints({
      config,
      ...endpointMessages,
    });
    const state = createOAuthState();
    const pkce = await createPkcePair();
    const authUrl = buildAuthorizationUrl({
      authorizationUrl: endpoints.authorizationUrl,
      redirectUrl: this.callbackUrl,
      scope: config.oauthScope,
      state,
      codeChallenge: pkce.codeChallenge,
      resource: config.sessionUrl,
      clientId: config.oauthClientId,
      loginHint,
      uiLanguage: messenger.i18n?.getUILanguage?.() || "",
    });

    const redirectWaiter = this.#createRedirectWaiter(state, messages.canceled);
    let wnd = null;
    try {
      wnd = await messenger.windows.create({
        titlePreface,
        type: "popup",
        url: authUrl,
        width: this.width,
        height: this.height,
      });
      redirectWaiter.setWindowId(wnd.id);
    } catch (error) {
      redirectWaiter.cancel();
      throw error;
    }

    const redirectedUrl = await redirectWaiter.promise;
    await messenger.windows.remove(wnd.id);

    const { code } = parseOAuthRedirect(redirectedUrl, state, messages, endpoints.issuer);
    const token = await exchangeAuthorizationCode({
      tokenUrl: endpoints.tokenUrl,
      code,
      redirectUrl: this.callbackUrl,
      codeVerifier: pkce.codeVerifier,
      clientId: config.oauthClientId,
    });

    return {
      ...config,
      oauthIssuerUrl: endpoints.issuer,
      oauthAuthorizationUrl: endpoints.authorizationUrl,
      oauthTokenUrl: endpoints.tokenUrl,
      oauthClientId: normalizeClientId(config.oauthClientId),
      token: token.accessToken,
      oauthRefreshToken: token.refreshToken,
      oauthExpiresAt: token.expiresAt,
      oauthScope: token.scope || config.oauthScope,
    };
  }

  #createRedirectWaiter(expectedState, canceledMessage = "OAuth login was canceled.") {
    let windowId = null;
    let settled = false;
    let cleanup = null;
    const navigationListeners = [];
    const promise = new Promise((resolve, reject) => {
      cleanup = () => {
        if (settled) {
          return;
        }

        settled = true;
        messenger.webRequest.onBeforeRequest.removeListener(requestListener);
        for (const [event, listener] of navigationListeners) {
          event.removeListener(listener);
        }
        messenger.windows.onRemoved.removeListener(windowListener);
      };
      const requestListener = details => {
        if (windowId != null && typeof details.windowId == "number" && details.windowId != windowId) {
          return;
        }

        if (!isExpectedOAuthRedirect(details.url, expectedState)) {
          return;
        }

        cleanup();
        resolve(new URL(details.url));
      };
      const windowListener = removedWindowId => {
        if (removedWindowId == windowId) {
          cleanup();
          reject(new Error(canceledMessage));
        }
      };

      messenger.windows.onRemoved.addListener(windowListener);
      messenger.webRequest.onBeforeRequest.addListener(requestListener, {
        urls: callbackUrlPatterns(this.callbackUrl),
      });
      for (const event of navigationEvents()) {
        event.addListener(requestListener, {
          url: callbackUrlNavigationFilters(this.callbackUrl),
        });
        navigationListeners.push([event, requestListener]);
      }
    });

    return {
      promise,
      setWindowId(value) {
        windowId = value;
      },
      cancel() {
        if (!settled) {
          cleanup?.();
        }
      },
    };
  }
}

function callbackUrlPatterns(callbackUrl) {
  if (callbackUrl == OAUTH_CALLBACK_URL) {
    return OAUTH_CALLBACK_URL_PATTERNS;
  }

  return [`${callbackUrl}*`];
}

function callbackUrlNavigationFilters(callbackUrl) {
  const url = new URL(callbackUrl);
  return [{
    hostEquals: url.hostname,
    schemes: url.protocol == "http:" ? ["http", "https"] : [url.protocol.slice(0, -1)],
  }];
}

function navigationEvents() {
  return [
    messenger.webNavigation?.onBeforeNavigate,
    messenger.webNavigation?.onCommitted,
    messenger.webNavigation?.onCompleted,
    messenger.webNavigation?.onErrorOccurred,
  ].filter(Boolean);
}

function isExpectedOAuthRedirect(urlValue, expectedState) {
  const url = new URL(urlValue);
  if (url.hostname != "localhost") {
    return false;
  }

  return url.searchParams.get("state") == expectedState;
}

export async function exchangeAuthorizationCode({
  tokenUrl,
  code,
  redirectUrl,
  codeVerifier,
  clientId = OPEN_CLIENT_ID,
  signal = null,
}) {
  return postTokenRequest(tokenUrl, {
    client_id: normalizeClientId(clientId),
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUrl,
    code_verifier: codeVerifier,
  }, { signal });
}

export async function refreshAccessToken({
  tokenUrl,
  refreshToken,
  clientId = OPEN_CLIENT_ID,
  signal = null,
}) {
  return postTokenRequest(tokenUrl, {
    client_id: normalizeClientId(clientId),
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  }, { signal });
}

export function normalizeClientId(clientId) {
  return clientId?.trim() || OPEN_CLIENT_ID;
}

export function getPreferredOAuthScope({
  resourceScopesSupported = [],
  authorizationScopesSupported = [],
} = {}) {
  const resourceScopes = new Set(resourceScopesSupported);
  const authorizationScopes = new Set(authorizationScopesSupported);
  const supportsMailScope = resourceScopes.has(MAIL_OAUTH_SCOPE) ||
    authorizationScopes.has(MAIL_OAUTH_SCOPE);
  const scopes = [supportsMailScope ? MAIL_OAUTH_SCOPE : LEGACY_JMAP_SIEVE_OAUTH_SCOPE];

  if (authorizationScopes.has("offline_access")) {
    scopes.push("offline_access");
  }

  return scopes.join(" ");
}

export async function resolveOAuthEndpoints({
  config,
  discover = discoverOAuthEndpoints,
  missingConfigurationMessage = "OAuth issuer URL or manual authorization and token URLs are required.",
  partialManualEndpointsMessage = "OAuth authorization URL and token URL are both required when entering endpoints manually.",
}) {
  const authorizationUrl = config.oauthAuthorizationUrl?.trim() || "";
  const tokenUrl = config.oauthTokenUrl?.trim() || "";
  const hasAuthorizationUrl = Boolean(authorizationUrl);
  const hasTokenUrl = Boolean(tokenUrl);

  if (hasAuthorizationUrl && hasTokenUrl) {
    return {
      issuer: config.oauthIssuerUrl ? normalizeIssuer(config.oauthIssuerUrl) : new URL(authorizationUrl).origin,
      authorizationUrl,
      tokenUrl,
    };
  }

  if (hasAuthorizationUrl || hasTokenUrl) {
    throw new Error(partialManualEndpointsMessage);
  }

  if (!config.oauthIssuerUrl) {
    throw new Error(missingConfigurationMessage);
  }

  return normalizeOAuthEndpoints(await discover({ issuerUrl: config.oauthIssuerUrl }));
}

export async function discoverOAuthEndpoints({
  issuerUrl,
  fetchImpl = fetch,
}) {
  const issuer = normalizeIssuer(issuerUrl);
  const responses = [
    await fetchAuthorizationMetadata(authorizationServerMetadataUrl(issuer), fetchImpl),
  ];

  if (!responses[0].ok) {
    responses.push(await fetchAuthorizationMetadata(openIdConfigurationUrl(issuer), fetchImpl));
  }

  const response = responses.find(candidate => candidate.ok);

  if (!response) {
    throw new Error(`OAuth metadata discovery failed with HTTP ${responses.at(-1).status}.`);
  }

  const metadata = await response.json();
  let metadataIssuer = "";
  try {
    metadataIssuer = metadata.issuer ? normalizeIssuer(metadata.issuer) : "";
  } catch (error) {
    throw new Error(`OAuth metadata issuer is invalid: ${metadata.issuer || "missing"}. ${error.message}`);
  }
  if (metadataIssuer != issuer) {
    throw new Error(`OAuth metadata issuer does not match the requested issuer: expected ${issuer}, got ${metadataIssuer || metadata.issuer || "missing"}.`);
  }
  if (!metadata.authorization_endpoint || !metadata.token_endpoint) {
    throw new Error("OAuth metadata did not include authorization and token endpoints.");
  }

  const oauthEndpoints = {
    issuer,
    authorizationUrl: metadata.authorization_endpoint,
    tokenUrl: metadata.token_endpoint,
    scopesSupported: metadata.scopes_supported || [],
  };

  if (!metadata.response_types_supported?.includes("code")) {
    throw oauthMetadataError("OAuth metadata does not support authorization code responses.", oauthEndpoints);
  }
  if (!metadata.grant_types_supported?.includes("authorization_code")) {
    throw oauthMetadataError("OAuth metadata does not support authorization code grants.", oauthEndpoints);
  }
  if (!metadata.token_endpoint_auth_methods_supported?.includes("none")) {
    throw oauthMetadataError("OAuth metadata does not support public clients.", oauthEndpoints);
  }
  if (!metadata.code_challenge_methods_supported?.includes("S256")) {
    throw oauthMetadataError("OAuth metadata does not support PKCE S256.", oauthEndpoints);
  }
  if (metadata.authorization_response_iss_parameter_supported !== true) {
    throw oauthMetadataError(
      "OAuth metadata does not support authorization response issuer identification.",
      oauthEndpoints
    );
  }

  return oauthEndpoints;
}

export async function discoverProtectedResourceMetadata({
  resourceUrl,
  metadataUrl = "",
  fetchImpl = fetch,
}) {
  const normalizedResourceUrl = normalizeResourceUrl(resourceUrl);
  const resolvedMetadataUrl = metadataUrl || protectedResourceMetadataUrl(normalizedResourceUrl);
  const response = await fetchImpl(resolvedMetadataUrl, { method: "GET" });

  if (!response.ok) {
    throw new Error(`Protected resource metadata discovery failed with HTTP ${response.status}.`);
  }

  const metadata = await response.json();
  if (metadata.resource != normalizedResourceUrl) {
    throw new Error("Protected resource metadata does not match the JMAP resource.");
  }
  if (!Array.isArray(metadata.authorization_servers) || !metadata.authorization_servers.length) {
    throw new Error("Protected resource metadata did not include authorization servers.");
  }

  return {
    resource: metadata.resource,
    authorizationServers: metadata.authorization_servers,
    scopesSupported: metadata.scopes_supported || [],
    metadataUrl: resolvedMetadataUrl,
  };
}

export function parseResourceMetadataFromAuthenticateHeader(headerValue = "") {
  const bearerIndex = headerValue.toLowerCase().indexOf("bearer ");
  if (bearerIndex == -1) {
    return "";
  }

  const parameters = parseHeaderParameters(headerValue.slice(bearerIndex + "bearer ".length));
  if (parameters.resource_metadata) {
    return parameters.resource_metadata;
  }

  return "";
}

export async function createPkcePair() {
  const codeVerifier = randomUrlSafeString(64);
  const challengeBytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier));

  return {
    codeVerifier,
    codeChallenge: base64UrlEncode(new Uint8Array(challengeBytes)),
  };
}

export function createOAuthState() {
  return randomUrlSafeString(32);
}

export function normalizeTokenResponse(response, now = Date.now()) {
  return {
    accessToken: response.access_token,
    refreshToken: response.refresh_token,
    tokenType: response.token_type || "bearer",
    expiresIn: response.expires_in || null,
    scope: response.scope || "",
    expiresAt: response.expires_in ? now + ((response.expires_in - OAUTH_EXPIRE_GRACE_SECONDS) * 1000) : null,
  };
}

export function parseOAuthRedirect(redirectedUrl, expectedState, messages = {}, expectedIssuer = "") {
  const url = redirectedUrl instanceof URL ? redirectedUrl : new URL(redirectedUrl);
  const error = url.searchParams.get("error");
  if (error) {
    throw new Error(url.searchParams.get("error_description") || error);
  }

  if (url.searchParams.get("state") != expectedState) {
    throw new Error(messages.stateMismatch || "The OAuth response did not match the request state.");
  }
  const actualIssuer = url.searchParams.get("iss") || "";
  if (expectedIssuer && actualIssuer != expectedIssuer) {
    throw new Error(getOAuthIssuerMismatchMessage(messages, {
      expectedIssuer,
      actualIssuer,
    }));
  }

  const code = url.searchParams.get("code");
  if (!code) {
    throw new Error(messages.missingCode || "The OAuth response did not include an authorization code.");
  }

  return { code };
}

function getOAuthIssuerMismatchMessage(messages, details) {
  if (typeof messages.issuerMismatch == "function") {
    return messages.issuerMismatch(details);
  }

  if (messages.issuerMismatch) {
    return messages.issuerMismatch;
  }

  return `OAuth response issuer did not match the configured OAuth Issuer URL. Expected ${details.expectedIssuer}, got ${details.actualIssuer || "missing"}. Update OAuth Issuer URL to match the authorization server issuer.`;
}

async function fetchAuthorizationMetadata(metadataUrl, fetchImpl) {
  const response = await fetchImpl(metadataUrl, {
    method: "GET",
    redirect: "manual",
  });
  const contentType = response.headers.get("Content-Type") || "";
  if (!response.ok || !contentType.toLowerCase().includes("application/json")) {
    return new Response("", { status: response.status || 0 });
  }

  return response;
}

function authorizationServerMetadataUrl(issuer) {
  const url = new URL(issuer);
  const path = url.pathname == "/" ? "" : url.pathname;
  return `${url.origin}/.well-known/oauth-authorization-server${path}`;
}

function openIdConfigurationUrl(issuer) {
  return `${issuer}/.well-known/openid-configuration`;
}

function protectedResourceMetadataUrl(resourceUrl) {
  const url = new URL(resourceUrl);
  const path = url.pathname == "/" ? "" : url.pathname;
  const search = url.search || "";
  return `${url.origin}/.well-known/oauth-protected-resource${path}${search}`;
}

function normalizeResourceUrl(resourceUrl) {
  const url = new URL(resourceUrl);
  url.hash = "";
  return url.toString();
}

function splitHeaderValues(headerValue) {
  const values = [];
  let current = "";
  let quoted = false;
  let escaped = false;

  for (const character of headerValue) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }

    if (character == "\\") {
      current += character;
      escaped = quoted;
      continue;
    }

    if (character == "\"") {
      quoted = !quoted;
      current += character;
      continue;
    }

    if (character == "," && !quoted) {
      values.push(current);
      current = "";
      continue;
    }

    current += character;
  }

  if (current) {
    values.push(current);
  }

  return values;
}

function parseHeaderParameters(value) {
  const parameters = {};
  for (const part of splitHeaderValues(value)) {
    const separatorIndex = part.indexOf("=");
    if (separatorIndex == -1) {
      continue;
    }

    const name = part.slice(0, separatorIndex).trim();
    const rawValue = part.slice(separatorIndex + 1).trim();
    if (!name) {
      continue;
    }

    parameters[name] = unquoteHeaderValue(rawValue);
  }

  return parameters;
}

function normalizeOAuthEndpoints(endpoints) {
  return {
    ...endpoints,
    scopesSupported: endpoints.scopesSupported || [],
  };
}

function oauthMetadataError(message, oauthEndpoints) {
  const error = new Error(message);
  error.details = { oauthEndpoints };
  return error;
}

function unquoteHeaderValue(value) {
  if (!value.startsWith("\"") || !value.endsWith("\"")) {
    return value;
  }

  let result = "";
  let escaped = false;
  for (const character of value.slice(1, -1)) {
    if (escaped) {
      result += character;
      escaped = false;
      continue;
    }

    if (character == "\\") {
      escaped = true;
      continue;
    }

    result += character;
  }

  return result;
}

async function postTokenRequest(tokenUrl, body, { signal = null } = {}) {
  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(body).toString(),
    signal,
  });

  if (!response.ok) {
    let details = null;
    try {
      details = await response.json();
    } catch (error) {
      details = { error: String(error) };
    }
    throw new Error(details.error_description || details.error || `OAuth token request failed with HTTP ${response.status}.`);
  }

  return normalizeTokenResponse(await response.json());
}

function randomUrlSafeString(length) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);

  return Array.from(bytes, byte => alphabet[byte % alphabet.length]).join("");
}

function base64UrlEncode(bytes) {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  const encoded = typeof btoa == "function" ?
    btoa(binary) :
    globalThis.Buffer.from(binary, "binary").toString("base64");

  return encoded.replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function normalizeIssuer(issuerUrl) {
  const url = new URL(issuerUrl);
  if (url.protocol != "https:" || url.search || url.hash) {
    throw new Error("OAuth issuer URL must be an HTTPS URL without query or fragment.");
  }
  const path = url.pathname.replace(/\/$/, "");
  return path ? `${url.origin}${path}` : url.origin;
}
