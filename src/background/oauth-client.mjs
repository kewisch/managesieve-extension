export const OPEN_CLIENT_ID = "open";
export const DEFAULT_OAUTH_SCOPE = "urn:ietf:params:jmap:core urn:ietf:params:jmap:sieve";
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
    browserApi = globalThis.browser,
    fetchImpl = defaultFetch,
    callbackUrl = OAUTH_CALLBACK_URL,
    width = OAUTH_WINDOW_WIDTH,
    height = OAUTH_WINDOW_HEIGHT,
  } = {}) {
    this.browserApi = browserApi;
    this.fetchImpl = fetchImpl;
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
      uiLanguage: this.browserApi.i18n?.getUILanguage?.() || "",
    });

    const redirectWaiter = this.#createRedirectWaiter(state, messages.canceled);
    let wnd = null;
    try {
      wnd = await this.browserApi.windows.create({
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
    await this.browserApi.windows.remove(wnd.id);

    const { code } = parseOAuthRedirect(redirectedUrl, state, messages);
    const token = await exchangeAuthorizationCode({
      fetchImpl: this.fetchImpl,
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
      oauthRegistrationUrl: endpoints.registrationUrl,
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
        this.browserApi.webRequest.onBeforeRequest.removeListener(requestListener);
        for (const [event, listener] of navigationListeners) {
          event.removeListener(listener);
        }
        this.browserApi.windows.onRemoved.removeListener(windowListener);
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

      this.browserApi.windows.onRemoved.addListener(windowListener);
      this.browserApi.webRequest.onBeforeRequest.addListener(requestListener, {
        urls: callbackUrlPatterns(this.callbackUrl),
      });
      for (const event of navigationEvents(this.browserApi)) {
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

function navigationEvents(browserApi) {
  return [
    browserApi.webNavigation?.onBeforeNavigate,
    browserApi.webNavigation?.onCommitted,
    browserApi.webNavigation?.onCompleted,
    browserApi.webNavigation?.onErrorOccurred,
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
  fetchImpl = defaultFetch,
  tokenUrl,
  code,
  redirectUrl,
  codeVerifier,
  clientId = OPEN_CLIENT_ID,
  signal = null,
}) {
  return postTokenRequest(fetchImpl, tokenUrl, {
    client_id: normalizeClientId(clientId),
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUrl,
    code_verifier: codeVerifier,
  }, { signal });
}

export async function refreshAccessToken({
  fetchImpl = defaultFetch,
  tokenUrl,
  refreshToken,
  clientId = OPEN_CLIENT_ID,
  signal = null,
}) {
  return postTokenRequest(fetchImpl, tokenUrl, {
    client_id: normalizeClientId(clientId),
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  }, { signal });
}

export function normalizeClientId(clientId) {
  return clientId?.trim() || OPEN_CLIENT_ID;
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
      registrationUrl: config.oauthRegistrationUrl?.trim() || "",
    };
  }

  if (hasAuthorizationUrl || hasTokenUrl) {
    throw new Error(partialManualEndpointsMessage);
  }

  if (!config.oauthIssuerUrl) {
    throw new Error(missingConfigurationMessage);
  }

  return discover({ issuerUrl: config.oauthIssuerUrl });
}

export async function discoverOAuthEndpoints({
  fetchImpl = defaultFetch,
  issuerUrl,
}) {
  const issuer = normalizeIssuer(issuerUrl);
  const metadataUrl = `${issuer}/.well-known/oauth-authorization-server`;
  const response = await fetchImpl(metadataUrl, { method: "GET" });

  if (!response.ok) {
    throw new Error(`OAuth metadata discovery failed with HTTP ${response.status}.`);
  }

  const metadata = await response.json();
  if (metadata.issuer && metadata.issuer != issuer) {
    throw new Error("OAuth metadata issuer does not match the requested issuer.");
  }
  if (!metadata.authorization_endpoint || !metadata.token_endpoint) {
    throw new Error("OAuth metadata did not include authorization and token endpoints.");
  }

  return {
    issuer,
    authorizationUrl: metadata.authorization_endpoint,
    tokenUrl: metadata.token_endpoint,
    registrationUrl: metadata.registration_endpoint || "",
  };
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

export function parseOAuthRedirect(redirectedUrl, expectedState, messages = {}) {
  const url = redirectedUrl instanceof URL ? redirectedUrl : new URL(redirectedUrl);
  const error = url.searchParams.get("error");
  if (error) {
    throw new Error(url.searchParams.get("error_description") || error);
  }

  if (url.searchParams.get("state") != expectedState) {
    throw new Error(messages.stateMismatch || "The OAuth response did not match the request state.");
  }

  const code = url.searchParams.get("code");
  if (!code) {
    throw new Error(messages.missingCode || "The OAuth response did not include an authorization code.");
  }

  return { code };
}

async function postTokenRequest(fetchImpl, tokenUrl, body, { signal = null } = {}) {
  const response = await fetchImpl(tokenUrl, {
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

function defaultFetch(url, options) {
  return globalThis.fetch(url, options);
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
  return url.origin;
}
