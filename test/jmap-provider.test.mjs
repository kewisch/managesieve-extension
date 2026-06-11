import assert from "node:assert/strict";
import test, { afterEach } from "node:test";

import { JmapSieveProvider } from "../src/background/jmap-provider.mjs";
import { ProviderError } from "../src/background/provider-error.mjs";

const SESSION = {
  capabilities: {
    "urn:ietf:params:jmap:core": {},
    "urn:ietf:params:jmap:sieve": {
      implementation: "Test Sieve",
    },
  },
  accounts: {
    sieveAccount: {
      name: "sieve@example.com",
      isReadOnly: false,
      accountCapabilities: {
        "urn:ietf:params:jmap:sieve": {
          maxSizeScriptName: 512,
          maxSizeScript: 65536,
          maxNumberScripts: null,
          sieveExtensions: ["fileinto"],
          notificationMethods: null,
          externalLists: null,
        },
      },
    },
  },
  primaryAccounts: {
    "urn:ietf:params:jmap:sieve": "sieveAccount",
  },
  username: "sieve@example.com",
  apiUrl: "/jmap/api/",
  downloadUrl: "/jmap/download/{accountId}/{blobId}/{name}?accept={type}",
  uploadUrl: "/jmap/upload/{accountId}/",
};

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json" },
  });
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function makeProvider(handler) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    return handler(String(url), options, calls.length - 1);
  };
  const provider = new JmapSieveProvider();
  return { provider, calls };
}

test("discovers a JMAP Sieve account from the identity domain", async () => {
  const { provider, calls } = makeProvider((url, options) => {
    assert.equal(url, "https://example.com/.well-known/jmap");
    assert.equal(options.headers.Authorization, "Bearer secret-token");
    return jsonResponse(SESSION);
  });

  const result = await provider.discover({
    authType: "bearer",
    token: "secret-token",
    thunderbirdAccount: {
      identities: [{ email: "user@example.com" }],
    },
  });

  assert.equal(result.sessionUrl, "https://example.com/.well-known/jmap");
  assert.equal(result.jmapAccountId, "sieveAccount");
  assert.equal(result.session.capabilities["urn:ietf:params:jmap:sieve"].implementation, "Test Sieve");
  assert.equal(calls.length, 1);
});

test("discovers a JMAP Sieve account from a server address", async () => {
  const { provider, calls } = makeProvider((url, options) => {
    assert.equal(url, "https://mail.thundermail.com/.well-known/jmap");
    assert.equal(options.headers.Authorization, "Bearer secret-token");
    return jsonResponse(SESSION);
  });

  const result = await provider.discover({
    authType: "bearer",
    token: "secret-token",
    sessionUrl: "mail.thundermail.com",
  });

  assert.equal(result.sessionUrl, "https://mail.thundermail.com/.well-known/jmap");
  assert.equal(calls.length, 1);
});

test("discovers a JMAP Sieve account from an origin URL", async () => {
  const { provider, calls } = makeProvider(url => {
    assert.equal(url, "https://mail.thundermail.com/.well-known/jmap");
    return jsonResponse(SESSION);
  });

  const result = await provider.discover({
    authType: "bearer",
    token: "secret-token",
    sessionUrl: "https://mail.thundermail.com",
  });

  assert.equal(result.sessionUrl, "https://mail.thundermail.com/.well-known/jmap");
  assert.equal(calls.length, 1);
});

test("reports missing JMAP Sieve capability during discovery", async () => {
  const { provider } = makeProvider(() => jsonResponse({
    ...SESSION,
    capabilities: {
      "urn:ietf:params:jmap:core": {},
    },
  }));

  await assert.rejects(
    () => provider.discover({
      authType: "bearer",
      token: "secret-token",
      sessionUrl: "https://example.com/.well-known/jmap",
    }),
    error => error instanceof ProviderError && error.code == "missingCapability"
  );
});

test("lists scripts through SieveScript/get", async () => {
  const { provider, calls } = makeProvider((url, options, index) => {
    if (index == 0) {
      return jsonResponse(SESSION);
    }

    assert.equal(url, "https://example.com/jmap/api/");
    const request = JSON.parse(options.body);
    assert.deepEqual(request.methodCalls[0], ["SieveScript/get", { accountId: "sieveAccount" }, "0"]);
    return jsonResponse({
      methodResponses: [[
        "SieveScript/get",
        {
          accountId: "sieveAccount",
          list: [
            { id: "one", name: "main", blobId: "blob-one", isActive: true },
          ],
          notFound: [],
          state: "state-one",
        },
        "0",
      ]],
    });
  });

  const connection = await provider.discover({
    authType: "bearer",
    token: "secret-token",
    sessionUrl: "https://example.com/.well-known/jmap",
  });
  const result = await provider.listScripts(connection);

  assert.deepEqual(result.scripts, [
    { id: "one", name: "main", blobId: "blob-one", isActive: true },
  ]);
  assert.equal(result.state, "state-one");
  assert.equal(calls.length, 2);
});

test("loads script content through the session downloadUrl", async () => {
  const { provider } = makeProvider((url, options, index) => {
    if (index == 0) {
      return jsonResponse(SESSION);
    }
    assert.equal(url, "https://example.com/jmap/download/sieveAccount/blob-one/main.siv?accept=application%2Fsieve");
    return new Response("require [\"fileinto\"];\n", {
      headers: { "Content-Type": "application/sieve" },
    });
  });

  const connection = await provider.discover({
    authType: "bearer",
    token: "secret-token",
    sessionUrl: "https://example.com/.well-known/jmap",
  });
  const content = await provider.loadScript(connection, {
    id: "one",
    name: "main.siv",
    blobId: "blob-one",
  });

  assert.equal(content, "require [\"fileinto\"];\n");
});

test("validates, saves, and creates scripts with uploaded blobs", async () => {
  const bodies = [];
  const { provider } = makeProvider((url, options, index) => {
    if (index == 0) {
      return jsonResponse(SESSION);
    }

    if (url == "https://example.com/jmap/upload/sieveAccount/") {
      return jsonResponse({ accountId: "sieveAccount", blobId: `blob-${index}` }, { status: 201 });
    }

    bodies.push(JSON.parse(options.body));
    if (bodies.at(-1).methodCalls[0][0] == "SieveScript/validate") {
      return jsonResponse({
        methodResponses: [["SieveScript/validate", { accountId: "sieveAccount", error: null }, "0"]],
      });
    }
    if (bodies.at(-1).methodCalls[0][1].update) {
      return jsonResponse({
        methodResponses: [["SieveScript/set", {
          accountId: "sieveAccount",
          updated: { scriptOne: null },
          notUpdated: null,
        }, "0"]],
      });
    }
    return jsonResponse({
      methodResponses: [["SieveScript/set", {
        accountId: "sieveAccount",
        created: {
          createdScript: { id: "new-id", name: "new script", blobId: "blob-new", isActive: false },
        },
        notCreated: null,
      }, "0"]],
    });
  });

  const connection = await provider.discover({
    authType: "bearer",
    token: "secret-token",
    sessionUrl: "https://example.com/.well-known/jmap",
  });

  assert.deepEqual(await provider.validateScript(connection, "keep;"), { ok: true, error: null });
  assert.deepEqual(await provider.saveScript(connection, "scriptOne", "keep;"), { ok: true });
  assert.deepEqual(await provider.createScript(connection, "new script", "keep;"), {
    id: "new-id",
    name: "new script",
    blobId: "blob-new",
    isActive: false,
  });

  assert.equal(bodies[0].methodCalls[0][0], "SieveScript/validate");
  assert.equal(bodies[1].methodCalls[0][1].update.scriptOne.blobId, "blob-3");
  assert.equal(bodies[2].methodCalls[0][1].create.createdScript.name, "new script");
});

test("rejects creating a script without content before uploading", async () => {
  const { provider, calls } = makeProvider((url, options, index) => {
    if (index == 0) {
      return jsonResponse(SESSION);
    }

    assert.fail(`unexpected request to ${url}`);
  });

  const connection = await provider.discover({
    authType: "bearer",
    token: "secret-token",
    sessionUrl: "https://example.com/.well-known/jmap",
  });

  await assert.rejects(
    () => provider.createScript(connection, "new script", "   \n"),
    error => error instanceof ProviderError && error.code == "missingScriptContent"
  );
  assert.equal(calls.length, 1);
});

test("activates an existing script through SieveScript/set", async () => {
  const bodies = [];
  const { provider } = makeProvider((url, options, index) => {
    if (index == 0) {
      return jsonResponse(SESSION);
    }

    bodies.push(JSON.parse(options.body));
    return jsonResponse({
      methodResponses: [["SieveScript/set", {
        accountId: "sieveAccount",
        updated: {
          scriptOne: { isActive: true },
          oldActive: { isActive: false },
        },
        notUpdated: null,
      }, "0"]],
    });
  });

  const connection = await provider.discover({
    authType: "bearer",
    token: "secret-token",
    sessionUrl: "https://example.com/.well-known/jmap",
  });

  assert.deepEqual(await provider.setActiveScript(connection, "scriptOne"), {
    ok: true,
    updated: {
      scriptOne: { isActive: true },
      oldActive: { isActive: false },
    },
  });
  assert.deepEqual(bodies[0].methodCalls[0], [
    "SieveScript/set",
    {
      accountId: "sieveAccount",
      onSuccessActivateScript: "scriptOne",
    },
    "0",
  ]);
});

test("accepts activation when SieveScript/set succeeds without an updated echo", async () => {
  const { provider } = makeProvider((url, options, index) => {
    if (index == 0) {
      return jsonResponse(SESSION);
    }

    return jsonResponse({
      methodResponses: [["SieveScript/set", {
        accountId: "sieveAccount",
        updated: null,
        notUpdated: null,
      }, "0"]],
    });
  });

  const connection = await provider.discover({
    authType: "bearer",
    token: "secret-token",
    sessionUrl: "https://example.com/.well-known/jmap",
  });

  assert.deepEqual(await provider.setActiveScript(connection, "scriptOne"), {
    ok: true,
    updated: {},
  });
});

test("reports activation failure when SieveScript/set returns notUpdated", async () => {
  const { provider } = makeProvider((url, options, index) => {
    if (index == 0) {
      return jsonResponse(SESSION);
    }

    return jsonResponse({
      methodResponses: [["SieveScript/set", {
        accountId: "sieveAccount",
        updated: null,
        notUpdated: {
          scriptOne: {
            type: "forbidden",
            description: "Cannot activate script.",
          },
        },
      }, "0"]],
    });
  });

  const connection = await provider.discover({
    authType: "bearer",
    token: "secret-token",
    sessionUrl: "https://example.com/.well-known/jmap",
  });

  await assert.rejects(
    () => provider.setActiveScript(connection, "scriptOne"),
    error => error instanceof ProviderError && error.code == "activationFailed"
  );
});

test("deactivates the active script through SieveScript/set", async () => {
  const bodies = [];
  const { provider } = makeProvider((url, options, index) => {
    if (index == 0) {
      return jsonResponse(SESSION);
    }

    bodies.push(JSON.parse(options.body));
    return jsonResponse({
      methodResponses: [["SieveScript/set", {
        accountId: "sieveAccount",
        updated: {
          scriptOne: { isActive: false },
        },
        notUpdated: null,
      }, "0"]],
    });
  });

  const connection = await provider.discover({
    authType: "bearer",
    token: "secret-token",
    sessionUrl: "https://example.com/.well-known/jmap",
  });

  assert.deepEqual(await provider.deactivateScript(connection, "scriptOne"), {
    ok: true,
    updated: {
      scriptOne: { isActive: false },
    },
  });
  assert.deepEqual(bodies[0].methodCalls[0], [
    "SieveScript/set",
    {
      accountId: "sieveAccount",
      onSuccessDeactivateScript: true,
    },
    "0",
  ]);
});

test("reports deactivation failure when SieveScript/set returns notUpdated", async () => {
  const { provider } = makeProvider((url, options, index) => {
    if (index == 0) {
      return jsonResponse(SESSION);
    }

    return jsonResponse({
      methodResponses: [["SieveScript/set", {
        accountId: "sieveAccount",
        updated: null,
        notUpdated: {
          scriptOne: {
            type: "forbidden",
            description: "Cannot deactivate script.",
          },
        },
      }, "0"]],
    });
  });

  const connection = await provider.discover({
    authType: "bearer",
    token: "secret-token",
    sessionUrl: "https://example.com/.well-known/jmap",
  });

  await assert.rejects(
    () => provider.deactivateScript(connection, "scriptOne"),
    error => error instanceof ProviderError && error.code == "deactivationFailed"
  );
});

test("destroys an inactive script through SieveScript/set", async () => {
  const bodies = [];
  const { provider } = makeProvider((url, options, index) => {
    if (index == 0) {
      return jsonResponse(SESSION);
    }

    bodies.push(JSON.parse(options.body));
    return jsonResponse({
      methodResponses: [["SieveScript/set", {
        accountId: "sieveAccount",
        destroyed: ["scriptOne"],
        notDestroyed: null,
      }, "0"]],
    });
  });

  const connection = await provider.discover({
    authType: "bearer",
    token: "secret-token",
    sessionUrl: "https://example.com/.well-known/jmap",
  });

  assert.deepEqual(await provider.destroyScript(connection, "scriptOne"), { ok: true });
  assert.deepEqual(bodies[0].methodCalls[0], [
    "SieveScript/set",
    {
      accountId: "sieveAccount",
      destroy: ["scriptOne"],
    },
    "0",
  ]);
});

test("reports destroy failure when SieveScript/set returns notDestroyed", async () => {
  const { provider } = makeProvider((url, options, index) => {
    if (index == 0) {
      return jsonResponse(SESSION);
    }

    return jsonResponse({
      methodResponses: [["SieveScript/set", {
        accountId: "sieveAccount",
        destroyed: null,
        notDestroyed: {
          scriptOne: {
            type: "forbidden",
            description: "Cannot destroy script.",
          },
        },
      }, "0"]],
    });
  });

  const connection = await provider.discover({
    authType: "bearer",
    token: "secret-token",
    sessionUrl: "https://example.com/.well-known/jmap",
  });

  await assert.rejects(
    () => provider.destroyScript(connection, "scriptOne"),
    error => error instanceof ProviderError && error.code == "destroyFailed"
  );
});

test("returns invalidSieve details from validation", async () => {
  const { provider } = makeProvider((url, options, index) => {
    if (index == 0) {
      return jsonResponse(SESSION);
    }
    if (url == "https://example.com/jmap/upload/sieveAccount/") {
      return jsonResponse({ accountId: "sieveAccount", blobId: "blob-invalid" }, { status: 201 });
    }
    return jsonResponse({
      methodResponses: [["SieveScript/validate", {
        accountId: "sieveAccount",
        error: {
          type: "invalidSieve",
          description: "line 1: expected command",
        },
      }, "0"]],
    });
  });

  const connection = await provider.discover({
    authType: "bearer",
    token: "secret-token",
    sessionUrl: "https://example.com/.well-known/jmap",
  });

  assert.deepEqual(await provider.validateScript(connection, "bad"), {
    ok: false,
    error: {
      type: "invalidSieve",
      description: "line 1: expected command",
    },
  });
});
