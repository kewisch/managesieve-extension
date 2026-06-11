import { normalizeJmapSessionUrl } from "./server-address.mjs";

const SIEVE_CAPABILITY = "urn:ietf:params:jmap:sieve";
const CORE_CAPABILITY = "urn:ietf:params:jmap:core";
const BLOB_CAPABILITY = "urn:ietf:params:jmap:blob";
const SIEVE_MIME_TYPE = "application/sieve";

export class ProviderError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "ProviderError";
    this.code = code;
    this.details = details;
  }
}

export class JmapSieveProvider {
  constructor({ fetchImpl = defaultFetch } = {}) {
    this.fetchImpl = fetchImpl;
  }

  async discover(config) {
    const sessionUrl = normalizeJmapSessionUrl(config.sessionUrl) || this.#getWellKnownUrl(config.thunderbirdAccount);
    if (!sessionUrl) {
      throw new ProviderError("missingSessionUrl", "No JMAP session URL is configured.");
    }

    const session = await this.#fetchJson(sessionUrl, {
      method: "GET",
      headers: this.#authHeaders(config),
    });
    const jmapAccountId = this.#getSieveAccountId(session);

    return {
      config,
      session,
      sessionUrl,
      jmapAccountId,
    };
  }

  async listScripts(connection) {
    const response = await this.#apiCall(connection, [
      "SieveScript/get",
      { accountId: connection.jmapAccountId },
      "0",
    ]);
    const data = this.#getMethodResponse(response, "SieveScript/get");

    return {
      scripts: data.list || [],
      state: data.state || null,
    };
  }

  async loadScript(connection, script) {
    if (!script?.blobId) {
      throw new ProviderError("missingBlob", "The selected script does not include a blob id.");
    }

    if (connection.session.downloadUrl) {
      const url = this.#templateUrl(connection.session.downloadUrl, connection, {
        blobId: script.blobId,
        name: script.name || "script.siv",
        type: SIEVE_MIME_TYPE,
      });
      const response = await this.fetchImpl(url, {
        method: "GET",
        headers: this.#authHeaders(connection.config),
      });
      await this.#ensureHttpOk(response, "downloadFailed");
      return response.text();
    }

    const response = await this.#apiCall(connection, [
      "Blob/get",
      {
        accountId: connection.jmapAccountId,
        ids: [script.blobId],
        properties: ["data:asText"],
      },
      "0",
    ], [BLOB_CAPABILITY]);
    const data = this.#getMethodResponse(response, "Blob/get");
    return data.list?.[0]?.["data:asText"] || "";
  }

  async validateScript(connection, content) {
    const blobId = await this.#uploadScript(connection, content);
    const response = await this.#apiCall(connection, [
      "SieveScript/validate",
      {
        accountId: connection.jmapAccountId,
        blobId,
      },
      "0",
    ]);
    const data = this.#getMethodResponse(response, "SieveScript/validate");

    if (data.error) {
      return {
        ok: false,
        error: data.error,
      };
    }

    return {
      ok: true,
      error: null,
    };
  }

  async saveScript(connection, scriptId, content) {
    const blobId = await this.#uploadScript(connection, content);
    const response = await this.#apiCall(connection, [
      "SieveScript/set",
      {
        accountId: connection.jmapAccountId,
        update: {
          [scriptId]: { blobId },
        },
      },
      "0",
    ]);
    const data = this.#getMethodResponse(response, "SieveScript/set");
    const failure = data.notUpdated?.[scriptId];

    if (failure) {
      throw new ProviderError("saveFailed", failure.description || failure.type || "The script could not be saved.", failure);
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

    const blobId = await this.#uploadScript(connection, content);
    const createId = "createdScript";
    const response = await this.#apiCall(connection, [
      "SieveScript/set",
      {
        accountId: connection.jmapAccountId,
        create: {
          [createId]: {
            name: name.trim(),
            blobId,
          },
        },
      },
      "0",
    ]);
    const data = this.#getMethodResponse(response, "SieveScript/set");
    const failure = data.notCreated?.[createId];

    if (failure) {
      throw new ProviderError("createFailed", failure.description || failure.type || "The script could not be created.", failure);
    }

    return data.created?.[createId];
  }

  async destroyScript(connection, scriptId) {
    if (!scriptId) {
      throw new ProviderError("missingScriptId", "A script id is required.");
    }

    const response = await this.#apiCall(connection, [
      "SieveScript/set",
      {
        accountId: connection.jmapAccountId,
        destroy: [scriptId],
      },
      "0",
    ]);
    const data = this.#getMethodResponse(response, "SieveScript/set");
    const failure = data.notDestroyed?.[scriptId];

    if (failure) {
      throw new ProviderError("destroyFailed", failure.description || failure.type || "The script could not be deleted.", failure);
    }

    return { ok: true };
  }

  async setActiveScript(connection, scriptId) {
    if (!scriptId) {
      throw new ProviderError("missingScriptId", "A script id is required.");
    }

    const response = await this.#apiCall(connection, [
      "SieveScript/set",
      {
        accountId: connection.jmapAccountId,
        onSuccessActivateScript: scriptId,
      },
      "0",
    ]);
    const data = this.#getMethodResponse(response, "SieveScript/set");
    const failure = data.notUpdated?.[scriptId];

    if (failure) {
      throw new ProviderError("activationFailed", failure.description || failure.type || "The script could not be activated.", failure);
    }

    return {
      ok: true,
      updated: data.updated || {},
    };
  }

  async deactivateScript(connection, scriptId) {
    if (!scriptId) {
      throw new ProviderError("missingScriptId", "A script id is required.");
    }

    const response = await this.#apiCall(connection, [
      "SieveScript/set",
      {
        accountId: connection.jmapAccountId,
        onSuccessDeactivateScript: true,
      },
      "0",
    ]);
    const data = this.#getMethodResponse(response, "SieveScript/set");
    const failure = data.notUpdated?.[scriptId];

    if (failure) {
      throw new ProviderError("deactivationFailed", failure.description || failure.type || "The script could not be deactivated.", failure);
    }

    return {
      ok: true,
      updated: data.updated || {},
    };
  }

  #getWellKnownUrl(thunderbirdAccount) {
    const email = thunderbirdAccount?.identities?.find(identity => identity.email)?.email;
    const domain = email?.split("@").pop();

    if (!domain) {
      return null;
    }

    return `https://${domain}/.well-known/jmap`;
  }

  #getSieveAccountId(session) {
    if (!session?.capabilities?.[SIEVE_CAPABILITY]) {
      throw new ProviderError("missingCapability", "This JMAP server does not advertise Sieve support.");
    }

    const primaryAccountId = session.primaryAccounts?.[SIEVE_CAPABILITY];
    if (primaryAccountId && this.#accountSupportsSieve(session.accounts?.[primaryAccountId])) {
      return primaryAccountId;
    }

    for (const [accountId, account] of Object.entries(session.accounts || {})) {
      if (!account.isReadOnly && this.#accountSupportsSieve(account)) {
        return accountId;
      }
    }

    throw new ProviderError("missingAccount", "No writable JMAP Sieve account is available.");
  }

  #accountSupportsSieve(account) {
    return Boolean(account?.accountCapabilities?.[SIEVE_CAPABILITY]);
  }

  async #uploadScript(connection, content) {
    const url = this.#templateUrl(connection.session.uploadUrl, connection);
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        ...this.#authHeaders(connection.config),
        "Content-Type": SIEVE_MIME_TYPE,
      },
      body: content,
    });
    await this.#ensureHttpOk(response, "uploadFailed");
    const data = await response.json();

    if (!data.blobId) {
      throw new ProviderError("uploadFailed", "The server did not return a blob id for the uploaded script.", data);
    }

    return data.blobId;
  }

  async #apiCall(connection, methodCall, extraCapabilities = []) {
    const apiUrl = this.#absoluteUrl(connection.session.apiUrl, connection.sessionUrl);
    return this.#fetchJson(apiUrl, {
      method: "POST",
      headers: {
        ...this.#authHeaders(connection.config),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        using: [CORE_CAPABILITY, SIEVE_CAPABILITY, ...extraCapabilities],
        methodCalls: [methodCall],
      }),
    });
  }

  #getMethodResponse(response, methodName) {
    const methodResponse = response.methodResponses?.find(([name]) => name == methodName);

    if (!methodResponse) {
      const errorResponse = response.methodResponses?.find(([name]) => name == "error");
      if (errorResponse) {
        throw new ProviderError(errorResponse[1].type || "jmapError", errorResponse[1].description || "The JMAP server returned an error.", errorResponse[1]);
      }

      throw new ProviderError("jmapError", `The JMAP response did not include ${methodName}.`, response);
    }

    return methodResponse[1];
  }

  async #fetchJson(url, options) {
    const response = await this.fetchImpl(url, options);
    await this.#ensureHttpOk(response, "httpError");
    return response.json();
  }

  async #ensureHttpOk(response, code) {
    if (response.ok) {
      return;
    }

    let details = null;
    try {
      details = await response.text();
    } catch (error) {
      details = String(error);
    }
    throw new ProviderError(code, `The server returned HTTP ${response.status}.`, details);
  }

  #authHeaders(config) {
    if (config.authType == "basic") {
      return {
        Authorization: `Basic ${this.#encodeBasic(config.username || "", config.password || "")}`,
      };
    }

    if (config.token) {
      return {
        Authorization: `Bearer ${config.token}`,
      };
    }

    return {};
  }

  #encodeBasic(username, password) {
    const value = `${username}:${password}`;

    if (typeof btoa == "function") {
      return btoa(value);
    }

    return globalThis.Buffer.from(value, "utf8").toString("base64");
  }

  #templateUrl(template, connection, replacements = {}) {
    const allReplacements = {
      accountId: connection.jmapAccountId,
      blobId: "",
      name: "",
      type: "",
      ...replacements,
    };
    const resolved = template.replaceAll(/\{([^}]+)\}/g, (match, name) => {
      if (name in allReplacements) {
        return encodeURIComponent(allReplacements[name]);
      }

      return match;
    });

    return this.#absoluteUrl(resolved, connection.sessionUrl);
  }

  #absoluteUrl(url, base) {
    return new URL(url, base).toString();
  }
}

function defaultFetch(url, options) {
  return globalThis.fetch(url, options);
}

export class TcpManageSieveProvider {
  async discover() {
    throw this.#unsupported();
  }

  async listScripts() {
    throw this.#unsupported();
  }

  async loadScript() {
    throw this.#unsupported();
  }

  async validateScript() {
    throw this.#unsupported();
  }

  async saveScript() {
    throw this.#unsupported();
  }

  async createScript() {
    throw this.#unsupported();
  }

  async destroyScript() {
    throw this.#unsupported();
  }

  async setActiveScript() {
    throw this.#unsupported();
  }

  async deactivateScript() {
    throw this.#unsupported();
  }

  #unsupported() {
    return new ProviderError("unsupportedProvider", "Direct TCP MANAGESIEVE connections are not implemented yet.");
  }
}
