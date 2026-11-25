import { AccountStorage } from "./account-storage.mjs";
import {
  discoverJmapAutoconfig,
  loadHardcodedServerConfigs,
  probeTcpAutoconfig,
} from "./autoconfig.mjs";
import { JmapSieveProvider } from "./jmap-provider.mjs";
import { OAuthWindowFlow, refreshAccessToken } from "./oauth-client.mjs";
import { ProviderError } from "./provider-error.mjs";
import { TcpManageSieveProvider } from "./tcp-provider.mjs";

const storage = new AccountStorage(messenger.storage.local);
const providers = {
  jmap: new JmapSieveProvider(),
  tcp: new TcpManageSieveProvider(),
};
const SAVE_REQUEST_TIMEOUT_MS = 30000;
let hardcodedServerConfigsPromise = null;

messenger.runtime.onStartup.addListener(() => createManageSieveMenu());

messenger.menus.onClicked.addListener(info => {
  if (info.menuItemId == "manageSieveToolsMenu") {
    openManagePage();
  }
});

messenger.runtime.onInstalled.addListener(details => {
  if (details.reason == "install") {
    createManageSieveMenu();
    openManagePage({ showWelcome: true });
  }
});

function createManageSieveMenu() {
  messenger.menus.create({
    id: "manageSieveToolsMenu",
    title: messenger.i18n.getMessage("extensionName"),
    contexts: ["tools_menu"],
    type: "normal",
  });
}

function openManagePage({ showWelcome = false } = {}) {
  messenger.tabs.create({
    url: messenger.runtime.getURL(`content/manage.html${showWelcome ? "?welcome" : ""}`),
  });
}

messenger.runtime.onMessage.addListener(message => {
  if (!message?.type?.startsWith("managesieve.")) {
    return false;
  }

  return handleMessage(message);
});

async function handleMessage(message) {
  try {
    switch (message.type) {
      case "managesieve.getAccounts":
        return await getAccounts();
      case "managesieve.saveConfig":
        return await saveConfig(message.accountId, message.config);
      case "managesieve.saveDetectedConfig":
        return await saveDetectedConfig(message.accountId, message.config);
      case "managesieve.saveManualConnection":
        return await saveManualConnection(message.config);
      case "managesieve.createManualConnection":
        return await createManualConnection(message.config);
      case "managesieve.removeManualConnection":
        return await removeManualConnection(message.accountId);
      case "managesieve.authorizeOAuth":
        return await authorizeOAuth(message.config);
      case "managesieve.discoverJmapOAuthConfig":
        return await discoverJmapOAuthConfig(message.serverAddress, message.accountId);
      case "managesieve.probeTcpAutoconfig":
        return await probeTcpAutoconfigMessage(message.config);
      case "managesieve.testConnection":
        return await testConnection(message.accountId, message.config);
      case "managesieve.listScripts":
        return await listScripts(message.accountId);
      case "managesieve.loadScript":
        return await loadScript(message.accountId, message.script);
      case "managesieve.validateScript":
        return await validateScript(message.accountId, message.content);
      case "managesieve.saveScript":
        return await saveScript(message.accountId, message.scriptId, message.content);
      case "managesieve.createScript":
        return await createScript(message.accountId, message.name, message.content);
      case "managesieve.deleteScript":
        return await deleteScript(message.accountId, message.scriptId);
      case "managesieve.setActiveScript":
        return await setActiveScript(message.accountId, message.scriptId);
      case "managesieve.deactivateScript":
        return await deactivateScript(message.accountId, message.scriptId);
      default:
        throw new ProviderError("unknownMessage", `Unknown message type: ${message.type}`);
    }
  } catch (error) {
    return {
      ok: false,
      error: serializeError(error),
    };
  }
}

async function getAccounts() {
  const accounts = await getKnownAccounts();
  const configs = await storage.getAllConfigs();
  return {
    ok: true,
    accounts,
    configs,
  };
}

async function saveConfig(accountId, config) {
  const savedConfig = await storage.setConfig(accountId, config);
  return {
    ok: true,
    config: savedConfig,
  };
}

async function saveDetectedConfig(accountId, config) {
  const account = await getThunderbirdAccount(accountId);
  const { provider, connection } = await getProviderConnection(account, config);
  try {
    const scripts = await provider.listScripts(connection);
    const savedConfig = await storage.setConfig(accountId, config);

    return {
      ok: true,
      config: savedConfig,
      sessionUrl: connection.sessionUrl,
      jmapAccountId: connection.jmapAccountId,
      scripts: scripts.scripts,
    };
  } finally {
    await closeProviderConnection(provider, connection);
  }
}

async function createManualConnection(config) {
  const provider = getProvider(config);
  let connection = null;
  try {
    connection = await provider.discover(config);
    const scripts = await provider.listScripts(connection);
    const account = await storage.createManualAccount(config);
    const savedConfig = await storage.getConfig(account.id);

    return {
      ok: true,
      account,
      config: savedConfig,
      sessionUrl: connection.sessionUrl,
      jmapAccountId: connection.jmapAccountId,
      scripts: scripts.scripts,
    };
  } finally {
    await closeProviderConnection(provider, connection);
  }
}

async function saveManualConnection(config) {
  const account = await storage.createManualAccount(config);
  const savedConfig = await storage.getConfig(account.id);

  return {
    ok: true,
    account,
    config: savedConfig,
    scripts: [],
  };
}

async function removeManualConnection(accountId) {
  if (!await storage.removeManualAccount(accountId)) {
    throw new ProviderError("removeManualServerFailed", "The manual server could not be removed.");
  }

  return {
    ok: true,
  };
}

async function authorizeOAuth(config) {
  const flow = new OAuthWindowFlow();
  return {
    ok: true,
    config: await flow.authorize(config, {
      titlePreface: `${messenger.i18n.getMessage("extensionShortName")} - `,
      endpointMessages: {
        missingConfigurationMessage: messenger.i18n.getMessage("oauthMissingEndpointConfiguration"),
        partialManualEndpointsMessage: messenger.i18n.getMessage("oauthIncompleteManualEndpoints"),
      },
      messages: {
        canceled: messenger.i18n.getMessage("oauthCanceled"),
        issuerMismatch: ({ expectedIssuer, actualIssuer }) => messenger.i18n.getMessage("oauthIssuerMismatch", [
          expectedIssuer,
          actualIssuer || messenger.i18n.getMessage("oauthIssuerMissing"),
        ]),
        stateMismatch: messenger.i18n.getMessage("oauthStateMismatch"),
        missingCode: messenger.i18n.getMessage("oauthMissingCode"),
      },
    }),
  };
}

async function discoverJmapOAuthConfig(serverAddress, accountId = null) {
  const account = accountId ? await getThunderbirdAccount(accountId) : null;
  return {
    ok: true,
    result: await discoverJmapAutoconfig({
      serverAddress,
      account,
      hardcodedConfigs: await getHardcodedServerConfigs(),
    }),
  };
}

function getHardcodedServerConfigs() {
  hardcodedServerConfigsPromise ??= loadHardcodedServerConfigs();
  return hardcodedServerConfigsPromise;
}

async function probeTcpAutoconfigMessage(config) {
  return {
    ok: true,
    result: await probeTcpAutoconfig({
      provider: providers.tcp,
      config,
    }),
  };
}

async function testConnection(accountId, config) {
  const account = await getThunderbirdAccount(accountId);
  const savedConfig = await storage.setConfig(accountId, config);
  const { provider, connection } = await getProviderConnection(account, savedConfig);
  try {
    const scripts = await provider.listScripts(connection);

    return {
      ok: true,
      sessionUrl: connection.sessionUrl,
      jmapAccountId: connection.jmapAccountId,
      scripts: scripts.scripts,
    };
  } finally {
    await closeProviderConnection(provider, connection);
  }
}

async function listScripts(accountId) {
  const { provider, connection } = await getConnection(accountId);
  try {
    const scripts = await provider.listScripts(connection);
    return {
      ok: true,
      ...scripts,
    };
  } finally {
    await closeProviderConnection(provider, connection);
  }
}

async function loadScript(accountId, script) {
  const { provider, connection } = await getConnection(accountId);
  try {
    let content;
    try {
      content = await provider.loadScript(connection, script);
    } catch (error) {
      if (!shouldRetryStaleBlobLoad(provider, error)) {
        throw error;
      }

      const scripts = await provider.listScripts(connection);
      const refreshedScript = findRefreshedScript(script, scripts.scripts);
      if (!refreshedScript || refreshedScript.blobId == script?.blobId) {
        throw error;
      }

      return {
        ok: true,
        content: await provider.loadScript(connection, refreshedScript),
        scripts: scripts.scripts,
        script: refreshedScript,
      };
    }

    return {
      ok: true,
      content,
    };
  } finally {
    await closeProviderConnection(provider, connection);
  }
}

async function validateScript(accountId, content) {
  const { provider, connection } = await getConnection(accountId);
  try {
    return {
      ok: true,
      result: await provider.validateScript(connection, content),
    };
  } finally {
    await closeProviderConnection(provider, connection);
  }
}

async function saveScript(accountId, scriptId, content) {
  return runTimedSaveOperation(async signal => {
    const { provider, connection } = await getConnection(accountId, { signal });
    try {
      const validation = await validateBeforeWrite(provider, connection, content);

      if (!validation.ok) {
        return {
          ok: true,
          result: validation,
        };
      }

      await provider.saveScript(connection, scriptId, content);
      return {
        ok: true,
        result: { ok: true, error: null },
      };
    } finally {
      await closeProviderConnection(provider, connection);
    }
  });
}

async function createScript(accountId, name, content) {
  if (!name?.trim()) {
    throw new ProviderError("missingScriptName", "A script name is required.");
  }
  if (!content?.trim()) {
    throw new ProviderError("missingScriptContent", "Script content is required.");
  }

  return runTimedSaveOperation(async signal => {
    const { provider, connection } = await getConnection(accountId, { signal });
    try {
      const validation = await validateBeforeWrite(provider, connection, content);

      if (!validation.ok) {
        return {
          ok: true,
          result: validation,
        };
      }

      return {
        ok: true,
        result: {
          ok: true,
          script: await provider.createScript(connection, name, content),
        },
      };
    } finally {
      await closeProviderConnection(provider, connection);
    }
  });
}

async function validateBeforeWrite(provider, connection, content) {
  if (provider.validateBeforeWrite === false) {
    return { ok: true, error: null };
  }

  return provider.validateScript(connection, content);
}

async function deleteScript(accountId, scriptId) {
  const { provider, connection } = await getConnection(accountId);
  try {
    return {
      ok: true,
      result: await provider.destroyScript(connection, scriptId),
    };
  } finally {
    await closeProviderConnection(provider, connection);
  }
}

async function setActiveScript(accountId, scriptId) {
  const { provider, connection } = await getConnection(accountId);
  try {
    return {
      ok: true,
      result: await provider.setActiveScript(connection, scriptId),
    };
  } finally {
    await closeProviderConnection(provider, connection);
  }
}

async function deactivateScript(accountId, scriptId) {
  const { provider, connection } = await getConnection(accountId);
  try {
    return {
      ok: true,
      result: await provider.deactivateScript(connection, scriptId),
    };
  } finally {
    await closeProviderConnection(provider, connection);
  }
}

async function getConnection(accountId, { signal = null } = {}) {
  const account = await getThunderbirdAccount(accountId);
  let config = await storage.getConfig(accountId);

  if (!config) {
    throw new ProviderError("unconfiguredAccount", "This account is not configured for JMAP Sieve.");
  }

  config = await refreshOAuthConfig(accountId, config, { signal });
  return getProviderConnection(account, { ...config, signal });
}

async function getProviderConnection(account, config) {
  const provider = getProvider(config);
  const connection = await provider.discover({
    ...config,
    thunderbirdAccount: account,
  });
  return { provider, connection };
}

function getProvider(config) {
  const provider = providers[config.provider || "jmap"];
  if (!provider) {
    throw new ProviderError("unsupportedProvider", `Unsupported Sieve connection type: ${config.provider}`);
  }

  return provider;
}

async function refreshOAuthConfig(accountId, config, { signal = null } = {}) {
  if (config.authType != "oauth" || !config.oauthRefreshToken || !config.oauthTokenUrl) {
    return config;
  }

  if (!config.oauthExpiresAt || config.oauthExpiresAt - Date.now() > 60000) {
    return config;
  }

  const token = await refreshAccessToken({
    tokenUrl: config.oauthTokenUrl,
    refreshToken: config.oauthRefreshToken,
    clientId: config.oauthClientId,
    signal,
  });
  return storage.setConfig(accountId, {
    ...config,
    token: token.accessToken,
    oauthRefreshToken: token.refreshToken || config.oauthRefreshToken,
    oauthExpiresAt: token.expiresAt,
    oauthScope: token.scope || config.oauthScope,
  });
}

function shouldRetryStaleBlobLoad(provider, error) {
  return provider == providers.jmap &&
    error instanceof ProviderError &&
    error.code == "downloadFailed" &&
    error.details?.status == 404;
}

function findRefreshedScript(script, scripts = []) {
  if (!script) {
    return null;
  }

  return scripts.find(candidate => candidate.id == script.id) ||
    scripts.find(candidate => candidate.name && candidate.name == script.name) ||
    null;
}

async function closeProviderConnection(provider, connection) {
  try {
    await provider?.closeConnection?.(connection);
  } catch {
    // Connection cleanup should not replace the operation result.
  }
}

async function runTimedSaveOperation(operation) {
  const abortController = new AbortController();
  let timeoutId = null;
  const operationPromise = Promise.resolve().then(() => operation(abortController.signal));
  operationPromise.catch(() => {});

  const timeoutPromise = new Promise((resolve, reject) => {
    timeoutId = setTimeout(() => {
      abortController.abort();
      reject(new ProviderError(
        "saveTimeout",
        messenger.i18n.getMessage("scriptSaveTimeout") || "Saving timed out. The server did not respond."
      ));
    }, SAVE_REQUEST_TIMEOUT_MS);
  });

  try {
    return await Promise.race([operationPromise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function getThunderbirdAccount(accountId) {
  const accounts = await getKnownAccounts();
  const account = accounts.find(candidate => candidate.id == accountId);

  if (!account) {
    throw new ProviderError("missingThunderbirdAccount", "The Thunderbird account is no longer available.");
  }

  return account;
}

async function getKnownAccounts() {
  const [thunderbirdAccounts, manualAccounts] = await Promise.all([
    messenger.accounts.list(false),
    storage.getManualAccounts(),
  ]);

  return [...thunderbirdAccounts, ...manualAccounts];
}

function serializeError(error) {
  return {
    code: error.code || "unexpectedError",
    message: error.message || String(error),
    details: error.details || null,
  };
}
