import assert from "node:assert/strict";
import test from "node:test";

import { ProviderError } from "../src/background/provider-error.mjs";
import { TcpManageSieveProvider } from "../src/background/tcp-provider.mjs";

function makeTcpApi(script = {}) {
  const calls = [];
  const lines = [...(script.greeting || [])];
  const chunks = [...(script.chunks || [])];
  const writes = script.writes || {};

  return {
    calls,
    api: {
      async connect(options) {
        calls.push({ method: "connect", options });
        return "socket-1";
      },
      async readLine(socketId) {
        calls.push({ method: "readLine", socketId });
        const line = lines.shift();
        if (line == null) {
          throw new Error("No scripted line available");
        }
        return line;
      },
      async read(socketId, byteCount) {
        calls.push({ method: "read", socketId, byteCount });
        const chunk = chunks.shift();
        if (chunk == null) {
          throw new Error("No scripted chunk available");
        }
        assert.equal(chunk.length, byteCount);
        return chunk;
      },
      async write(socketId, data) {
        calls.push({ method: "write", socketId, data });
        const response = writes[data];
        if (response) {
          lines.push(...(response.lines || []));
          chunks.push(...(response.chunks || []));
        }
      },
      async startTLS(socketId) {
        calls.push({ method: "startTLS", socketId });
      },
      async close(socketId) {
        calls.push({ method: "close", socketId });
      },
    },
  };
}

const STARTTLS_GREETING = [
  "\"IMPLEMENTATION\" \"Fake ManageSieve\"",
  "\"SASL\" \"\"",
  "\"SIEVE\" \"fileinto vacation\"",
  "\"STARTTLS\"",
  "OK",
];

const TLS_CAPABILITIES = [
  "\"IMPLEMENTATION\" \"Fake ManageSieve\"",
  "\"SASL\" \"PLAIN\"",
  "\"SIEVE\" \"fileinto vacation\"",
  "OK",
];

function makeAuthenticatedProvider(extraWrites = {}) {
  const { api, calls } = makeTcpApi({
    greeting: STARTTLS_GREETING,
    writes: {
      "STARTTLS\r\n": {
        lines: [
          "OK",
          ...TLS_CAPABILITIES,
        ],
      },
      "AUTHENTICATE \"PLAIN\" \"AHVzZXIAcGFzcw==\"\r\n": {
        lines: ["OK"],
      },
      ...extraWrites,
    },
  });
  return {
    provider: new TcpManageSieveProvider({ tcpApi: api }),
    calls,
  };
}

test("TCP provider connects with host permission marker options and authenticates over STARTTLS", async () => {
  const { provider, calls } = makeAuthenticatedProvider();

  const connection = await provider.discover({
    sessionUrl: "sieve.example.net",
    tcpPort: 4190,
    tcpSecurity: "starttls",
    username: "user",
    password: "pass",
  });

  assert.equal(connection.socketId, "socket-1");
  assert.deepEqual(calls[0], {
    method: "connect",
    options: {
      host: "sieve.example.net",
      port: 4190,
      security: "plain",
      connectTimeout: 30,
    },
  });
  assert.equal(calls.some(call => call.method == "startTLS"), true);
  assert.equal(calls.some(call => call.method == "write" && call.data == "AUTHENTICATE \"PLAIN\" \"AHVzZXIAcGFzcw==\"\r\n"), true);
});

test("TCP provider ignores an accidental port suffix in the host field", async () => {
  const { provider, calls } = makeAuthenticatedProvider();

  await provider.discover({
    sessionUrl: "sieve.example.net:4190",
    tcpPort: 4190,
    tcpSecurity: "starttls",
    username: "user",
    password: "pass",
  });

  assert.equal(calls[0].options.host, "sieve.example.net");
});

test("TCP provider lists active and inactive scripts", async () => {
  const { provider } = makeAuthenticatedProvider({
    "LISTSCRIPTS\r\n": {
      lines: [
        "\"main\" ACTIVE",
        "\"archive\"",
        "OK",
      ],
    },
  });

  const connection = await provider.discover({
    sessionUrl: "sieve.example.net",
    tcpSecurity: "starttls",
    username: "user",
    password: "pass",
  });

  assert.deepEqual(await provider.listScripts(connection), {
    scripts: [
      { id: "main", name: "main", isActive: true },
      { id: "archive", name: "archive", isActive: false },
    ],
    state: null,
  });
});

test("TCP provider loads script literals", async () => {
  const { provider } = makeAuthenticatedProvider({
    "GETSCRIPT \"main\"\r\n": {
      lines: [
        "{15}",
        "OK",
      ],
      chunks: ["require \"file\";"],
    },
  });

  const connection = await provider.discover({
    sessionUrl: "sieve.example.net",
    tcpSecurity: "starttls",
    username: "user",
    password: "pass",
  });

  assert.equal(await provider.loadScript(connection, { id: "main" }), "require \"file\";");
});

test("TCP provider ignores a blank separator line after script literals", async () => {
  const { provider } = makeAuthenticatedProvider({
    "GETSCRIPT \"main\"\r\n": {
      lines: [
        "{15}",
        "",
        "OK",
      ],
      chunks: ["require \"file\";"],
    },
  });

  const connection = await provider.discover({
    sessionUrl: "sieve.example.net",
    tcpSecurity: "starttls",
    username: "user",
    password: "pass",
  });

  assert.equal(await provider.loadScript(connection, { id: "main" }), "require \"file\";");
});

test("TCP provider validates, saves, creates, activates, deactivates, and deletes scripts", async () => {
  const { provider, calls } = makeAuthenticatedProvider({
    "CHECKSCRIPT {5+}\r\nkeep;\r\n": {
      lines: ["OK"],
    },
    "PUTSCRIPT \"main\" {5+}\r\nkeep;\r\n": {
      lines: ["OK"],
    },
    "PUTSCRIPT \"new\" {5+}\r\nkeep;\r\n": {
      lines: ["OK"],
    },
    "SETACTIVE \"main\"\r\n": {
      lines: ["OK"],
    },
    "SETACTIVE \"\"\r\n": {
      lines: ["OK"],
    },
    "DELETESCRIPT \"old\"\r\n": {
      lines: ["OK"],
    },
  });

  const connection = await provider.discover({
    sessionUrl: "sieve.example.net",
    tcpSecurity: "starttls",
    username: "user",
    password: "pass",
  });

  assert.deepEqual(await provider.validateScript(connection, "keep;"), { ok: true, error: null });
  assert.deepEqual(await provider.saveScript(connection, "main", "keep;"), { ok: true });
  assert.deepEqual(await provider.createScript(connection, "new", "keep;"), {
    id: "new",
    name: "new",
    isActive: false,
  });
  assert.deepEqual(await provider.setActiveScript(connection, "main"), { ok: true });
  assert.deepEqual(await provider.deactivateScript(connection, "main"), { ok: true });
  assert.deepEqual(await provider.destroyScript(connection, "old"), { ok: true });

  assert.equal(calls.some(call => call.method == "write" && call.data == "CHECKSCRIPT {5+}\r\nkeep;\r\n"), true);
  assert.equal(calls.some(call => call.method == "write" && call.data == "SETACTIVE \"\"\r\n"), true);
});

test("TCP provider logs out and closes authenticated sockets", async () => {
  const { provider, calls } = makeAuthenticatedProvider();

  const connection = await provider.discover({
    sessionUrl: "sieve.example.net",
    tcpSecurity: "starttls",
    username: "user",
    password: "pass",
  });

  await provider.closeConnection(connection);

  assert.equal(calls.some(call => call.method == "write" && call.data == "LOGOUT\r\n"), true);
  assert.equal(calls.at(-1).method, "close");
});

test("TCP provider advertises UTF-8 byte lengths for script literals", async () => {
  const content = "# Grüße\nkeep;";
  const byteLength = new TextEncoder().encode(content).length;
  const { provider, calls } = makeAuthenticatedProvider({
    [`PUTSCRIPT "unicode" {${byteLength}+}\r\n${content}\r\n`]: {
      lines: ["OK"],
    },
  });

  const connection = await provider.discover({
    sessionUrl: "sieve.example.net",
    tcpSecurity: "starttls",
    username: "user",
    password: "pass",
  });

  assert.notEqual(byteLength, content.length);
  assert.deepEqual(await provider.saveScript(connection, "unicode", content), { ok: true });
  assert.equal(
    calls.some(call => call.method == "write" && call.data.startsWith(`PUTSCRIPT "unicode" {${byteLength}+}\r\n`)),
    true
  );
});

test("TCP provider reports validation failures as invalidSieve", async () => {
  const { provider } = makeAuthenticatedProvider({
    "CHECKSCRIPT {4+}\r\nbad;\r\n": {
      lines: ["NO \"line 1: expected command\""],
    },
  });

  const connection = await provider.discover({
    sessionUrl: "sieve.example.net",
    tcpSecurity: "starttls",
    username: "user",
    password: "pass",
  });

  assert.deepEqual(await provider.validateScript(connection, "bad;"), {
    ok: false,
    error: {
      type: "invalidSieve",
      description: "line 1: expected command",
    },
  });
});

test("TCP provider reports BYE during validation as a command failure", async () => {
  const { provider } = makeAuthenticatedProvider({
    "CHECKSCRIPT {4+}\r\nbad;\r\n": {
      lines: ["BYE \"server shutting down\""],
    },
  });

  const connection = await provider.discover({
    sessionUrl: "sieve.example.net",
    tcpSecurity: "starttls",
    username: "user",
    password: "pass",
  });

  await assert.rejects(
    () => provider.validateScript(connection, "bad;"),
    error => error instanceof ProviderError &&
      error.code == "serverClosed" &&
      error.message == "server shutting down"
  );
});

test("TCP provider refuses plaintext authentication when STARTTLS is unavailable", async () => {
  const { api } = makeTcpApi({
    greeting: [
      "\"IMPLEMENTATION\" \"Fake ManageSieve\"",
      "\"SASL\" \"PLAIN\"",
      "\"SIEVE\" \"fileinto\"",
      "OK",
    ],
  });
  const provider = new TcpManageSieveProvider({ tcpApi: api });

  await assert.rejects(
    () => provider.discover({
      sessionUrl: "sieve.example.net",
      tcpSecurity: "starttls",
      username: "user",
      password: "pass",
    }),
    error => error instanceof ProviderError && error.code == "startTlsUnavailable"
  );
});

test("TCP provider surfaces missing host permission from the generic TCP API", async () => {
  const provider = new TcpManageSieveProvider({
    tcpApi: {
      async connect() {
        throw Object.assign(new Error("Missing host permission."), { code: "missingHostPermission" });
      },
    },
  });

  await assert.rejects(
    () => provider.discover({
      sessionUrl: "sieve.example.net",
      tcpSecurity: "tls",
      username: "user",
      password: "pass",
    }),
    error => error instanceof ProviderError && error.code == "missingHostPermission"
  );
});
