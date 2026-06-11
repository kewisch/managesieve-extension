import { ProviderError } from "./provider-error.mjs";

export class TcpManageSieveProvider {
  constructor({ tcpApi = defaultTcpApi(), connectTimeout = 30 } = {}) {
    this.tcpApi = tcpApi;
    this.connectTimeout = connectTimeout;
    this.validateBeforeWrite = false;
  }

  async discover(config) {
    const host = this.#normalizeHost(config.sessionUrl);
    const port = Number(config.tcpPort || 4190);
    const security = config.tcpSecurity == "tls" ? "tls" : "plain";
    const signal = config.signal || null;

    if (!host) {
      throw new ProviderError("missingTcpHost", "No TCP ManageSieve host is configured.");
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new ProviderError("invalidTcpPort", "The TCP ManageSieve port must be between 1 and 65535.");
    }
    if (!config.username || !config.password) {
      throw new ProviderError("missingCredentials", "A user name and password are required for TCP ManageSieve.");
    }
    if (signal?.aborted) {
      throw new ProviderError("requestAborted", "The TCP ManageSieve request was cancelled.");
    }

    let socketId = null;
    try {
      socketId = await this.tcpApi.connect({
        host,
        port,
        security,
        connectTimeout: this.connectTimeout,
      });
    } catch (error) {
      throw this.#providerError(error, "tcpConnectFailed", "The TCP connection could not be opened.");
    }
    const abortConnection = () => {
      Promise.resolve(this.tcpApi.close?.(socketId)).catch(() => {});
    };
    signal?.addEventListener("abort", abortConnection, { once: true });
    if (signal?.aborted) {
      abortConnection();
      throw new ProviderError("requestAborted", "The TCP ManageSieve request was cancelled.");
    }

    const connection = {
      config,
      host,
      port,
      socketId,
      capabilities: null,
      signal,
      abortConnection,
      closed: false,
    };

    try {
      connection.capabilities = await this.#readCapabilities(socketId);

      if (config.tcpSecurity == "tls") {
        await this.#authenticate(connection);
        return connection;
      }

      if (!connection.capabilities.has("STARTTLS")) {
        throw new ProviderError("startTlsUnavailable", "The server does not advertise STARTTLS.");
      }

      await this.#sendCommand(connection, "STARTTLS");
      await this.tcpApi.startTLS(socketId);
      connection.capabilities = await this.#readCapabilities(socketId);
      await this.#authenticate(connection);
      return connection;
    } catch (error) {
      await this.tcpApi.close?.(socketId);
      throw error;
    }
  }

  async listScripts(connection) {
    await this.#writeLine(connection, "LISTSCRIPTS");
    const lines = await this.#readDataLinesUntilOk(connection);

    return {
      scripts: lines.map(line => {
        const tokens = parseManageSieveTokens(line);
        return {
          id: tokens[0],
          name: tokens[0],
          isActive: tokens.slice(1).some(token => token.toUpperCase() == "ACTIVE"),
        };
      }),
      state: null,
    };
  }

  async loadScript(connection, script) {
    if (!script?.id) {
      throw new ProviderError("missingScriptId", "A script id is required.");
    }

    await this.#writeLine(connection, `GETSCRIPT ${quoteManageSieveString(script.id)}`);
    const line = await this.tcpApi.readLine(connection.socketId);
    const literalSize = this.#parseLiteralSize(line);
    const content = await this.tcpApi.read(connection.socketId, literalSize);
    await this.#ensureOk(await this.#readStatusLine(connection), "loadFailed");
    return content;
  }

  async validateScript(connection, content) {
    const response = await this.#sendLiteralCommand(connection, "CHECKSCRIPT", "", content);
    if (response.ok) {
      return { ok: true, error: null };
    }

    return {
      ok: false,
      error: {
        type: "invalidSieve",
        description: response.message || "The server reported a Sieve validation error.",
      },
    };
  }

  async closeConnection(connection) {
    if (!connection?.socketId || connection.closed) {
      return;
    }

    connection.closed = true;
    connection.signal?.removeEventListener("abort", connection.abortConnection);
    try {
      await this.#writeLine(connection, "LOGOUT");
    } catch {
      // Best-effort protocol shutdown; always close the transport below.
    } finally {
      try {
        await this.tcpApi.close?.(connection.socketId);
      } catch {
        // The socket may already be gone after abort or remote close.
      }
    }
  }

  async saveScript(connection, scriptId, content) {
    if (!scriptId) {
      throw new ProviderError("missingScriptId", "A script id is required.");
    }

    const response = await this.#sendLiteralCommand(connection, "PUTSCRIPT", quoteManageSieveString(scriptId), content);
    if (!response.ok) {
      throw new ProviderError("saveFailed", response.message || "The script could not be saved.", response);
    }

    return { ok: true };
  }

  async createScript(connection, name, content) {
    if (!name?.trim()) {
      throw new ProviderError("missingScriptName", "A script name is required.");
    }
    if (!content?.trim()) {
      throw new ProviderError("missingScriptContent", "Script content is required.");
    }

    const scriptName = name.trim();
    const response = await this.#sendLiteralCommand(connection, "PUTSCRIPT", quoteManageSieveString(scriptName), content);
    if (!response.ok) {
      throw new ProviderError("createFailed", response.message || "The script could not be created.", response);
    }

    return {
      id: scriptName,
      name: scriptName,
      isActive: false,
    };
  }

  async destroyScript(connection, scriptId) {
    if (!scriptId) {
      throw new ProviderError("missingScriptId", "A script id is required.");
    }

    const response = await this.#sendCommand(connection, `DELETESCRIPT ${quoteManageSieveString(scriptId)}`);
    if (!response.ok) {
      throw new ProviderError("destroyFailed", response.message || "The script could not be deleted.", response);
    }

    return { ok: true };
  }

  async setActiveScript(connection, scriptId) {
    if (!scriptId) {
      throw new ProviderError("missingScriptId", "A script id is required.");
    }

    const response = await this.#sendCommand(connection, `SETACTIVE ${quoteManageSieveString(scriptId)}`);
    if (!response.ok) {
      throw new ProviderError("activationFailed", response.message || "The script could not be activated.", response);
    }

    return { ok: true };
  }

  async deactivateScript(connection) {
    const response = await this.#sendCommand(connection, `SETACTIVE ${quoteManageSieveString("")}`);
    if (!response.ok) {
      throw new ProviderError("deactivationFailed", response.message || "The script could not be deactivated.", response);
    }

    return { ok: true };
  }

  async #authenticate(connection) {
    const mechanisms = connection.capabilities.get("SASL")?.toUpperCase().split(/\s+/).filter(Boolean) || [];
    if (!mechanisms.includes("PLAIN")) {
      throw new ProviderError("plainAuthUnavailable", "The server does not advertise SASL PLAIN after TLS.");
    }

    const response = await this.#sendCommand(
      connection,
      `AUTHENTICATE "PLAIN" ${quoteManageSieveString(this.#encodeBase64(`\0${connection.config.username}\0${connection.config.password}`))}`
    );
    if (!response.ok) {
      throw new ProviderError("authenticationFailed", response.message || "The server rejected the TCP ManageSieve credentials.", response);
    }
  }

  async #readCapabilities(socketId) {
    const capabilities = new Map();

    while (true) {
      const line = await this.tcpApi.readLine(socketId);
      const response = parseManageSieveResponse(line);
      if (response) {
        if (!response.ok) {
          throw new ProviderError("capabilityFailed", response.message || "The server did not return ManageSieve capabilities.", response);
        }
        return capabilities;
      }

      const [name, value = ""] = parseManageSieveTokens(line);
      if (name) {
        capabilities.set(name.toUpperCase(), value);
      }
    }
  }

  async #readDataLinesUntilOk(connection) {
    const lines = [];

    while (true) {
      const line = await this.tcpApi.readLine(connection.socketId);
      const response = parseManageSieveResponse(line);
      if (response) {
        if (!response.ok) {
          throw new ProviderError("commandFailed", response.message || "The ManageSieve command failed.", response);
        }
        return lines;
      }
      lines.push(line);
    }
  }

  async #sendCommand(connection, command) {
    await this.#writeLine(connection, command);
    return this.#ensureOk(await this.#readStatusLine(connection), "commandFailed");
  }

  async #sendLiteralCommand(connection, command, argument, content) {
    const literalPrefix = `${command}${argument ? ` ${argument}` : ""} {${this.#byteLength(content)}+}\r\n`;
    const payload = `${literalPrefix}${content}\r\n`;
    await this.tcpApi.write(connection.socketId, payload);
    return this.#ensureOk(await this.#readStatusLine(connection), "commandFailed", false);
  }

  async #writeLine(connection, command) {
    const payload = `${command}\r\n`;
    await this.tcpApi.write(connection.socketId, payload);
  }

  async #readStatusLine(connection) {
    let line = await this.tcpApi.readLine(connection.socketId);
    while (line == "") {
      line = await this.tcpApi.readLine(connection.socketId);
    }
    return line;
  }

  #ensureOk(line, errorCode, throwOnNo = true) {
    const response = parseManageSieveResponse(line);
    if (!response) {
      throw new ProviderError("unexpectedResponse", `Unexpected ManageSieve response: ${line}`);
    }
    if (response.status == "BYE") {
      throw new ProviderError("serverClosed", response.message || "The ManageSieve server closed the connection.", response);
    }
    if (response.ok || !throwOnNo && response.status == "NO") {
      return response;
    }

    throw new ProviderError(errorCode, response.message || "The ManageSieve command failed.", response);
  }

  #parseLiteralSize(line) {
    const match = /^\{(\d+)\}$/.exec(line);
    if (!match) {
      throw new ProviderError("unexpectedResponse", `Expected a ManageSieve literal response, got: ${line}`);
    }
    return Number(match[1]);
  }

  #normalizeHost(serverAddress) {
    const trimmedAddress = serverAddress?.trim() || "";
    if (!trimmedAddress) {
      return "";
    }

    if (/^[a-z][a-z\d+.-]*:\/\//i.test(trimmedAddress)) {
      return new URL(trimmedAddress).hostname;
    }

    return trimmedAddress.replace(/\/.*$/, "").replace(/:\d+$/, "");
  }

  #providerError(error, code, message) {
    if (error instanceof ProviderError) {
      return error;
    }

    const codedMessage = /^([a-z][a-zA-Z]+):\s*(.+)$/.exec(error.message || "");
    if (codedMessage) {
      return new ProviderError(codedMessage[1], codedMessage[2], error.details || null);
    }

    return new ProviderError(error.code || code, error.message || message, error.details || null);
  }

  #encodeBase64(value) {
    if (typeof btoa == "function") {
      return btoa(value);
    }

    return globalThis.Buffer.from(value, "utf8").toString("base64");
  }

  #byteLength(value) {
    return new TextEncoder().encode(value).length;
  }
}

function defaultTcpApi() {
  return (globalThis.messenger || globalThis.browser).tcp;
}

function parseManageSieveResponse(line) {
  const [status, ...rest] = parseManageSieveTokens(line);
  const upperStatus = status?.toUpperCase();
  if (!["OK", "NO", "BYE"].includes(upperStatus)) {
    return null;
  }

  return {
    ok: upperStatus == "OK",
    status: upperStatus,
    message: rest.at(-1) || "",
    tokens: rest,
  };
}

function parseManageSieveTokens(line) {
  const tokens = [];
  let index = 0;

  while (index < line.length) {
    while (line[index] == " ") {
      index++;
    }
    if (index >= line.length) {
      break;
    }

    if (line[index] == "\"") {
      const parsed = parseQuotedManageSieveString(line, index);
      tokens.push(parsed.value);
      index = parsed.nextIndex;
      continue;
    }

    const start = index;
    while (index < line.length && line[index] != " ") {
      index++;
    }
    tokens.push(line.slice(start, index));
  }

  return tokens;
}

function parseQuotedManageSieveString(line, startIndex) {
  let value = "";
  let index = startIndex + 1;

  while (index < line.length) {
    const char = line[index];
    if (char == "\\") {
      value += line[index + 1] || "";
      index += 2;
      continue;
    }
    if (char == "\"") {
      return {
        value,
        nextIndex: index + 1,
      };
    }
    value += char;
    index++;
  }

  throw new ProviderError("unexpectedResponse", `Unterminated quoted ManageSieve string: ${line}`);
}

function quoteManageSieveString(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`;
}
