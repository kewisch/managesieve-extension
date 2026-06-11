import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import {
  OAUTH_CALLBACK_URL,
  OAUTH_CALLBACK_URL_PATTERNS,
  OAuthWindowFlow,
  OPEN_CLIENT_ID,
  buildAuthorizationUrl,
  discoverOAuthEndpoints,
  exchangeAuthorizationCode,
  refreshAccessToken,
  resolveOAuthEndpoints,
} from "../src/background/oauth-client.mjs";

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

const originalFetch = globalThis.fetch;
const originalMessenger = globalThis.messenger;

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.messenger = originalMessenger;
});

function useFetch(handler) {
  globalThis.fetch = handler;
}

function useMessenger(messengerMock) {
  globalThis.messenger = messengerMock;
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (predicate()) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 0));
  }

  throw new Error("Timed out waiting for async OAuth test state.");
}

test("builds an OAuth authorization URL using the open client id and PKCE", () => {
  const url = new URL(buildAuthorizationUrl({
    authorizationUrl: "https://auth.example.net/oauth/authorize",
    redirectUrl: "https://extension.example/redirect",
    scope: "urn:ietf:params:jmap:core urn:ietf:params:jmap:sieve",
    state: "state-value",
    codeChallenge: "challenge-value",
    resource: "https://api.example.net/jmap/session",
  }));

  assert.equal(url.origin + url.pathname, "https://auth.example.net/oauth/authorize");
  assert.equal(url.searchParams.get("client_id"), OPEN_CLIENT_ID);
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("redirect_uri"), "https://extension.example/redirect");
  assert.equal(url.searchParams.get("scope"), "urn:ietf:params:jmap:core urn:ietf:params:jmap:sieve");
  assert.equal(url.searchParams.get("state"), "state-value");
  assert.equal(url.searchParams.get("code_challenge"), "challenge-value");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("resource"), "https://api.example.net/jmap/session");
});

test("exchanges an authorization code using the open client id", async () => {
  let requestBody = "";
  useFetch(async (url, options) => {
    assert.equal(url, "https://auth.example.net/oauth/token");
    requestBody = options.body;
    return jsonResponse({
      access_token: "access-token",
      refresh_token: "refresh-token",
      token_type: "bearer",
      expires_in: 3600,
      scope: "urn:ietf:params:jmap:core",
    });
  });

  const token = await exchangeAuthorizationCode({
    tokenUrl: "https://auth.example.net/oauth/token",
    code: "authorization-code",
    redirectUrl: "https://extension.example/redirect",
    codeVerifier: "verifier-value",
  });

  const params = new URLSearchParams(requestBody);
  assert.equal(params.get("client_id"), OPEN_CLIENT_ID);
  assert.equal(params.get("grant_type"), "authorization_code");
  assert.equal(params.get("code"), "authorization-code");
  assert.equal(params.get("redirect_uri"), "https://extension.example/redirect");
  assert.equal(params.get("code_verifier"), "verifier-value");
  assert.equal(token.accessToken, "access-token");
  assert.equal(token.refreshToken, "refresh-token");
  assert.equal(token.expiresIn, 3600);
});

test("exchanges an authorization code using a custom client id", async () => {
  let requestBody = "";
  useFetch(async (url, options) => {
    requestBody = options.body;
    return jsonResponse({
      access_token: "access-token",
      refresh_token: "refresh-token",
    });
  });

  await exchangeAuthorizationCode({
    tokenUrl: "https://auth.example.net/oauth/token",
    code: "authorization-code",
    redirectUrl: "https://extension.example/redirect",
    codeVerifier: "verifier-value",
    clientId: "custom-client",
  });

  assert.equal(new URLSearchParams(requestBody).get("client_id"), "custom-client");
});

test("exchanges an authorization code with global fetch", async () => {
  let requestBody = "";
  useFetch(async (url, options) => {
    assert.equal(url, "https://auth.example.net/oauth/token");
    requestBody = options.body;
    return jsonResponse({
      access_token: "access-token",
      refresh_token: "refresh-token",
    });
  });

  await exchangeAuthorizationCode({
    tokenUrl: "https://auth.example.net/oauth/token",
    code: "authorization-code",
    redirectUrl: "http://localhost/",
    codeVerifier: "verifier-value",
  });

  assert.equal(new URLSearchParams(requestBody).get("code"), "authorization-code");
});

test("refreshes an access token using the open client id", async () => {
  let requestBody = "";
  useFetch(async (url, options) => {
    assert.equal(url, "https://auth.example.net/oauth/token");
    requestBody = options.body;
    return jsonResponse({
      access_token: "new-access-token",
      refresh_token: "new-refresh-token",
      token_type: "bearer",
      expires_in: 7200,
    });
  });

  const token = await refreshAccessToken({
    tokenUrl: "https://auth.example.net/oauth/token",
    refreshToken: "old-refresh-token",
  });

  const params = new URLSearchParams(requestBody);
  assert.equal(params.get("client_id"), OPEN_CLIENT_ID);
  assert.equal(params.get("grant_type"), "refresh_token");
  assert.equal(params.get("refresh_token"), "old-refresh-token");
  assert.equal(token.accessToken, "new-access-token");
  assert.equal(token.refreshToken, "new-refresh-token");
  assert.equal(token.expiresIn, 7200);
});

test("refreshes an access token using a custom client id", async () => {
  let requestBody = "";
  useFetch(async (url, options) => {
    requestBody = options.body;
    return jsonResponse({
      access_token: "new-access-token",
      refresh_token: "new-refresh-token",
    });
  });

  await refreshAccessToken({
    tokenUrl: "https://auth.example.net/oauth/token",
    refreshToken: "old-refresh-token",
    clientId: "custom-client",
  });

  assert.equal(new URLSearchParams(requestBody).get("client_id"), "custom-client");
});

test("discovers OAuth URLs from authorization server metadata", async () => {
  useFetch(async url => {
    assert.equal(url, "https://auth.example.net/.well-known/oauth-authorization-server");
    return jsonResponse({
      issuer: "https://auth.example.net",
      authorization_endpoint: "https://auth.example.net/oauth/authorize",
      token_endpoint: "https://auth.example.net/oauth/token",
      registration_endpoint: "https://auth.example.net/oauth/register",
    });
  });

  const endpoints = await discoverOAuthEndpoints({
    issuerUrl: "https://auth.example.net",
  });

  assert.deepEqual(endpoints, {
    issuer: "https://auth.example.net",
    authorizationUrl: "https://auth.example.net/oauth/authorize",
    tokenUrl: "https://auth.example.net/oauth/token",
    registrationUrl: "https://auth.example.net/oauth/register",
  });
});

test("uses manual OAuth endpoints without fetching metadata", async () => {
  const endpoints = await resolveOAuthEndpoints({
    config: {
      oauthIssuerUrl: "https://bad-metadata.example.net",
      oauthAuthorizationUrl: "https://auth.example.net/oauth/authorize",
      oauthTokenUrl: "https://auth.example.net/oauth/token",
    },
    discover: async () => {
      throw new Error("metadata discovery should not run");
    },
  });

  assert.deepEqual(endpoints, {
    issuer: "https://bad-metadata.example.net",
    authorizationUrl: "https://auth.example.net/oauth/authorize",
    tokenUrl: "https://auth.example.net/oauth/token",
    registrationUrl: "",
  });
});

test("discovers OAuth endpoints when manual URLs are missing", async () => {
  const endpoints = await resolveOAuthEndpoints({
    config: {
      oauthIssuerUrl: "https://auth.example.net",
      oauthAuthorizationUrl: "",
      oauthTokenUrl: "",
    },
    discover: async ({ issuerUrl }) => {
      assert.equal(issuerUrl, "https://auth.example.net");
      return {
        issuer: "https://auth.example.net",
        authorizationUrl: "https://auth.example.net/oauth/authorize",
        tokenUrl: "https://auth.example.net/oauth/token",
        registrationUrl: "https://auth.example.net/oauth/register",
      };
    },
  });

  assert.deepEqual(endpoints, {
    issuer: "https://auth.example.net",
    authorizationUrl: "https://auth.example.net/oauth/authorize",
    tokenUrl: "https://auth.example.net/oauth/token",
    registrationUrl: "https://auth.example.net/oauth/register",
  });
});

test("OAuth window flow captures localhost redirect and exchanges the code", async () => {
  const listeners = {
    beforeRequest: null,
    windowRemoved: null,
  };
  let createdWindow = null;
  let removedWindowId = null;
  let tokenRequestBody = "";

  const messengerMock = {
    i18n: {
      getUILanguage: () => "en-US",
    },
    windows: {
      create: async createData => {
        createdWindow = createData;
        return { id: 42 };
      },
      remove: async windowId => {
        removedWindowId = windowId;
      },
      onRemoved: {
        addListener: listener => {
          listeners.windowRemoved = listener;
        },
        removeListener: listener => {
          if (listeners.windowRemoved == listener) {
            listeners.windowRemoved = null;
          }
        },
      },
    },
    webRequest: {
      onBeforeRequest: {
        addListener: (listener, filter) => {
          listeners.beforeRequest = { listener, filter };
        },
        removeListener: listener => {
          if (listeners.beforeRequest?.listener == listener) {
            listeners.beforeRequest = null;
          }
        },
      },
    },
  };

  useFetch(async (url, options) => {
    assert.equal(url, "https://auth.example.net/oauth/token");
    tokenRequestBody = options.body;
    return jsonResponse({
      access_token: "access-token",
      refresh_token: "refresh-token",
      expires_in: 3600,
      scope: "urn:ietf:params:jmap:sieve",
    });
  });
  useMessenger(messengerMock);
  const flow = new OAuthWindowFlow();

  const authorization = flow.authorize({
    sessionUrl: "https://jmap.example.net/session",
    oauthAuthorizationUrl: "https://auth.example.net/oauth/authorize",
    oauthTokenUrl: "https://auth.example.net/oauth/token",
    oauthClientId: "open",
    oauthScope: "urn:ietf:params:jmap:sieve",
  });

  await waitFor(() => createdWindow && listeners.beforeRequest);
  assert.equal(createdWindow.type, "popup");
  assert.equal(createdWindow.width, 430);
  assert.equal(createdWindow.height, 750);
  assert.deepEqual(listeners.beforeRequest.filter.urls, OAUTH_CALLBACK_URL_PATTERNS);
  assert.equal("windowId" in listeners.beforeRequest.filter, false);

  const authUrl = new URL(createdWindow.url);
  assert.equal(authUrl.origin + authUrl.pathname, "https://auth.example.net/oauth/authorize");
  assert.equal(authUrl.searchParams.get("redirect_uri"), OAUTH_CALLBACK_URL);
  assert.equal(authUrl.searchParams.get("client_id"), "open");
  listeners.beforeRequest.listener({
    url: `${OAUTH_CALLBACK_URL}?code=authorization-code&state=${authUrl.searchParams.get("state")}`,
  });

  const config = await authorization;
  assert.equal(removedWindowId, 42);
  assert.equal(config.token, "access-token");
  assert.equal(config.oauthRefreshToken, "refresh-token");
  assert.equal(config.oauthTokenUrl, "https://auth.example.net/oauth/token");
  assert.equal(config.oauthAuthorizationUrl, "https://auth.example.net/oauth/authorize");

  const params = new URLSearchParams(tokenRequestBody);
  assert.equal(params.get("code"), "authorization-code");
  assert.equal(params.get("redirect_uri"), OAUTH_CALLBACK_URL);
});

test("OAuth window flow captures HTTPS localhost redirects", async () => {
  const listeners = {
    beforeRequest: null,
    windowRemoved: null,
  };
  let tokenRequestBody = "";

  const messengerMock = {
    i18n: {
      getUILanguage: () => "en-US",
    },
    windows: {
      lastCreatedUrl: "",
      create: async createData => {
        messengerMock.windows.lastCreatedUrl = createData.url;
        return { id: 42 };
      },
      remove: async () => {},
      onRemoved: {
        addListener: listener => {
          listeners.windowRemoved = listener;
        },
        removeListener: listener => {
          if (listeners.windowRemoved == listener) {
            listeners.windowRemoved = null;
          }
        },
      },
    },
    webRequest: {
      onBeforeRequest: {
        addListener: (listener, filter) => {
          listeners.beforeRequest = { listener, filter };
        },
        removeListener: listener => {
          if (listeners.beforeRequest?.listener == listener) {
            listeners.beforeRequest = null;
          }
        },
      },
    },
  };

  useFetch(async (url, options) => {
    tokenRequestBody = options.body;
    return jsonResponse({
      access_token: "access-token",
      refresh_token: "refresh-token",
    });
  });
  useMessenger(messengerMock);
  const flow = new OAuthWindowFlow();
  const authorization = flow.authorize({
    oauthAuthorizationUrl: "https://auth.example.net/oauth/authorize",
    oauthTokenUrl: "https://auth.example.net/oauth/token",
    oauthClientId: "open",
    oauthScope: "urn:ietf:params:jmap:sieve",
  });

  await waitFor(() => listeners.beforeRequest);
  assert.deepEqual(listeners.beforeRequest.filter.urls, OAUTH_CALLBACK_URL_PATTERNS);
  listeners.beforeRequest.listener({
    url: `https://localhost/?code=https-code&state=${new URL(messengerMock.windows.lastCreatedUrl).searchParams.get("state")}`,
  });

  const config = await authorization;
  assert.equal(config.token, "access-token");
  assert.equal(new URLSearchParams(tokenRequestBody).get("code"), "https-code");
  assert.equal(new URLSearchParams(tokenRequestBody).get("redirect_uri"), OAUTH_CALLBACK_URL);
});

test("OAuth window flow captures localhost callback through webNavigation", async () => {
  const listeners = {
    beforeRequest: null,
    beforeNavigate: null,
    committed: null,
    completed: null,
    navigationError: null,
    windowRemoved: null,
  };
  let createdWindow = null;
  let tokenRequestBody = "";

  const navigationEvent = name => ({
    addListener: (listener, filter) => {
      listeners[name] = { listener, filter };
    },
    removeListener: listener => {
      if (listeners[name]?.listener == listener) {
        listeners[name] = null;
      }
    },
  });
  const messengerMock = {
    i18n: {
      getUILanguage: () => "en-US",
    },
    windows: {
      create: async createData => {
        createdWindow = createData;
        return { id: 42 };
      },
      remove: async () => {},
      onRemoved: {
        addListener: listener => {
          listeners.windowRemoved = listener;
        },
        removeListener: listener => {
          if (listeners.windowRemoved == listener) {
            listeners.windowRemoved = null;
          }
        },
      },
    },
    webRequest: {
      onBeforeRequest: {
        addListener: listener => {
          listeners.beforeRequest = listener;
        },
        removeListener: listener => {
          if (listeners.beforeRequest == listener) {
            listeners.beforeRequest = null;
          }
        },
      },
    },
    webNavigation: {
      onBeforeNavigate: navigationEvent("beforeNavigate"),
      onCommitted: navigationEvent("committed"),
      onCompleted: navigationEvent("completed"),
      onErrorOccurred: navigationEvent("navigationError"),
    },
  };

  useFetch(async (url, options) => {
    tokenRequestBody = options.body;
    return jsonResponse({
      access_token: "access-token",
      refresh_token: "refresh-token",
    });
  });
  useMessenger(messengerMock);
  const flow = new OAuthWindowFlow();
  const authorization = flow.authorize({
    oauthAuthorizationUrl: "https://auth.example.net/oauth/authorize",
    oauthTokenUrl: "https://auth.example.net/oauth/token",
    oauthClientId: "open",
    oauthScope: "urn:ietf:params:jmap:sieve",
  });

  await waitFor(() => createdWindow && listeners.beforeNavigate);
  assert.deepEqual(listeners.beforeNavigate.filter, {
    url: [{ hostEquals: "localhost", schemes: ["http", "https"] }],
  });
  const state = new URL(createdWindow.url).searchParams.get("state");
  listeners.beforeNavigate.listener({
    url: `${OAUTH_CALLBACK_URL}?code=navigation-code&state=${state}`,
  });

  const config = await authorization;
  assert.equal(config.token, "access-token");
  assert.equal(new URLSearchParams(tokenRequestBody).get("code"), "navigation-code");
  assert.equal(listeners.beforeRequest, null);
  assert.equal(listeners.beforeNavigate, null);
  assert.equal(listeners.committed, null);
  assert.equal(listeners.completed, null);
  assert.equal(listeners.navigationError, null);
});

test("OAuth window flow ignores localhost navigation without the expected state", async () => {
  const listeners = {
    beforeNavigate: null,
    windowRemoved: null,
  };
  const messengerMock = {
    i18n: {
      getUILanguage: () => "en-US",
    },
    windows: {
      create: async () => ({ id: 42 }),
      remove: async () => {},
      onRemoved: {
        addListener: listener => {
          listeners.windowRemoved = listener;
        },
        removeListener: listener => {
          if (listeners.windowRemoved == listener) {
            listeners.windowRemoved = null;
          }
        },
      },
    },
    webRequest: {
      onBeforeRequest: {
        addListener: () => {},
        removeListener: () => {},
      },
    },
    webNavigation: {
      onBeforeNavigate: {
        addListener: listener => {
          listeners.beforeNavigate = listener;
        },
        removeListener: listener => {
          if (listeners.beforeNavigate == listener) {
            listeners.beforeNavigate = null;
          }
        },
      },
    },
  };

  useMessenger(messengerMock);
  const flow = new OAuthWindowFlow();
  const authorization = flow.authorize({
    oauthAuthorizationUrl: "https://auth.example.net/oauth/authorize",
    oauthTokenUrl: "https://auth.example.net/oauth/token",
    oauthClientId: "open",
    oauthScope: "urn:ietf:params:jmap:sieve",
  });

  await waitFor(() => listeners.beforeNavigate && listeners.windowRemoved);
  listeners.beforeNavigate({
    url: `${OAUTH_CALLBACK_URL}?code=wrong-code&state=wrong-state`,
  });
  assert.notEqual(listeners.beforeNavigate, null);

  listeners.windowRemoved(42);
  await assert.rejects(authorization, /OAuth login was canceled/);
});

test("OAuth window flow registers the redirect listener before opening the login window", async () => {
  const events = [];
  let beforeRequest = null;
  let removedWindowId = null;

  const messengerMock = {
    i18n: {
      getUILanguage: () => "en-US",
    },
    windows: {
      create: async createData => {
        events.push("create");
        assert.ok(beforeRequest, "redirect listener should be registered before the login window opens");

        const state = new URL(createData.url).searchParams.get("state");
        beforeRequest.listener({
          url: `${OAUTH_CALLBACK_URL}?code=early-code&state=${state}`,
        });
        return { id: 42 };
      },
      remove: async windowId => {
        removedWindowId = windowId;
      },
      onRemoved: {
        addListener: listener => {
          events.push("windowRemovedListener");
        },
        removeListener: () => {},
      },
    },
    webRequest: {
      onBeforeRequest: {
        addListener: (listener, filter) => {
          events.push("redirectListener");
          beforeRequest = { listener, filter };
        },
        removeListener: listener => {
          if (beforeRequest?.listener == listener) {
            beforeRequest = null;
          }
        },
      },
    },
  };

  useFetch(async (url, options) => {
    assert.equal(new URLSearchParams(options.body).get("code"), "early-code");
    return jsonResponse({
      access_token: "access-token",
      refresh_token: "refresh-token",
    });
  });
  useMessenger(messengerMock);
  const flow = new OAuthWindowFlow();

  const config = await flow.authorize({
    oauthAuthorizationUrl: "https://auth.example.net/oauth/authorize",
    oauthTokenUrl: "https://auth.example.net/oauth/token",
    oauthClientId: "open",
    oauthScope: "urn:ietf:params:jmap:sieve",
  });

  assert.deepEqual(events.slice(0, 2), ["windowRemovedListener", "redirectListener"]);
  assert.equal(events[2], "create");
  assert.equal(config.token, "access-token");
  assert.equal(removedWindowId, 42);
});

test("OAuth window flow ignores localhost redirects from other windows", async () => {
  const listeners = {
    beforeRequest: null,
    windowRemoved: null,
  };
  const messengerMock = {
    i18n: {
      getUILanguage: () => "en-US",
    },
    windows: {
      create: async () => ({ id: 42 }),
      remove: async () => {},
      onRemoved: {
        addListener: listener => {
          listeners.windowRemoved = listener;
        },
        removeListener: listener => {
          if (listeners.windowRemoved == listener) {
            listeners.windowRemoved = null;
          }
        },
      },
    },
    webRequest: {
      onBeforeRequest: {
        addListener: (listener, filter) => {
          listeners.beforeRequest = { listener, filter };
        },
        removeListener: listener => {
          if (listeners.beforeRequest?.listener == listener) {
            listeners.beforeRequest = null;
          }
        },
      },
    },
  };

  useFetch(async () => jsonResponse({
    access_token: "access-token",
    refresh_token: "refresh-token",
  }));
  useMessenger(messengerMock);
  const flow = new OAuthWindowFlow();
  const authorization = flow.authorize({
    oauthAuthorizationUrl: "https://auth.example.net/oauth/authorize",
    oauthTokenUrl: "https://auth.example.net/oauth/token",
    oauthClientId: "open",
    oauthScope: "urn:ietf:params:jmap:sieve",
  });

  await waitFor(() => listeners.beforeRequest);
  listeners.beforeRequest.listener({
    windowId: 7,
    url: `${OAUTH_CALLBACK_URL}?code=wrong-window`,
  });
  assert.notEqual(listeners.beforeRequest, null);

  listeners.windowRemoved(42);
  await assert.rejects(authorization, /OAuth login was canceled/);
});

test("OAuth window flow rejects when the login window is closed", async () => {
  const listeners = {
    beforeRequest: null,
    windowRemoved: null,
  };
  const messengerMock = {
    i18n: {
      getUILanguage: () => "en-US",
    },
    windows: {
      create: async () => ({ id: 42 }),
      remove: async () => {},
      onRemoved: {
        addListener: listener => {
          listeners.windowRemoved = listener;
        },
        removeListener: listener => {
          if (listeners.windowRemoved == listener) {
            listeners.windowRemoved = null;
          }
        },
      },
    },
    webRequest: {
      onBeforeRequest: {
        addListener: listener => {
          listeners.beforeRequest = listener;
        },
        removeListener: listener => {
          if (listeners.beforeRequest == listener) {
            listeners.beforeRequest = null;
          }
        },
      },
    },
  };

  useMessenger(messengerMock);
  const flow = new OAuthWindowFlow();
  const authorization = flow.authorize({
    oauthAuthorizationUrl: "https://auth.example.net/oauth/authorize",
    oauthTokenUrl: "https://auth.example.net/oauth/token",
    oauthClientId: "open",
    oauthScope: "urn:ietf:params:jmap:sieve",
  });

  await waitFor(() => listeners.windowRemoved);
  listeners.windowRemoved(42);
  await assert.rejects(authorization, /OAuth login was canceled/);
  assert.equal(listeners.beforeRequest, null);
  assert.equal(listeners.windowRemoved, null);
});
