import { AccountStorage } from "./account-storage.mjs";
import { JmapSieveProvider, TcpManageSieveProvider, ProviderError } from "./jmap-provider.mjs";
import { OAuthWindowFlow, refreshAccessToken } from "./oauth-client.mjs";

const messengerApi = globalThis.messenger || globalThis.browser;
const storage = new AccountStorage(messengerApi.storage.local);
const providers = {
  jmap: new JmapSieveProvider(),
  tcp: new TcpManageSieveProvider(),
};

messengerApi.action.onClicked.addListener(() => {
  messengerApi.tabs.create({
    url: messengerApi.runtime.getURL("content/manage.html"),
  });
});

messengerApi.runtime.onMessage.addListener(message => {
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
      case "managesieve.saveManualConnection":
        return await saveManualConnection(message.config);
      case "managesieve.createManualConnection":
        return await createManualConnection(message.config);
      case "managesieve.removeManualConnection":
        return await removeManualConnection(message.accountId);
      case "managesieve.authorizeOAuth":
        return await authorizeOAuth(message.config);
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

async function createManualConnection(config) {
  const connection = await providers.jmap.discover(config);
  const scripts = await providers.jmap.listScripts(connection);
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
  const flow = new OAuthWindowFlow({ browserApi: messengerApi });
  return {
    ok: true,
    config: await flow.authorize(config, {
      titlePreface: `${messengerApi.i18n.getMessage("extensionShortName")} - `,
      endpointMessages: {
        missingConfigurationMessage: messengerApi.i18n.getMessage("oauthMissingEndpointConfiguration"),
        partialManualEndpointsMessage: messengerApi.i18n.getMessage("oauthIncompleteManualEndpoints"),
      },
      messages: {
        canceled: messengerApi.i18n.getMessage("oauthCanceled"),
        stateMismatch: messengerApi.i18n.getMessage("oauthStateMismatch"),
        missingCode: messengerApi.i18n.getMessage("oauthMissingCode"),
      },
    }),
  };
}

async function testConnection(accountId, config) {
  const account = await getThunderbirdAccount(accountId);
  const savedConfig = await storage.setConfig(accountId, config);
  const connection = await discover(account, savedConfig);
  const scripts = await providers.jmap.listScripts(connection);

  return {
    ok: true,
    sessionUrl: connection.sessionUrl,
    jmapAccountId: connection.jmapAccountId,
    scripts: scripts.scripts,
  };
}

async function listScripts(accountId) {
  const connection = await getConnection(accountId);
  const scripts = await providers.jmap.listScripts(connection);
  return {
    ok: true,
    ...scripts,
  };
}

async function loadScript(accountId, script) {
  const connection = await getConnection(accountId);
  return {
    ok: true,
    content: await providers.jmap.loadScript(connection, script),
  };
}

async function validateScript(accountId, content) {
  const connection = await getConnection(accountId);
  return {
    ok: true,
    result: await providers.jmap.validateScript(connection, content),
  };
}

async function saveScript(accountId, scriptId, content) {
  const connection = await getConnection(accountId);
  const validation = await providers.jmap.validateScript(connection, content);

  if (!validation.ok) {
    return {
      ok: true,
      result: validation,
    };
  }

  await providers.jmap.saveScript(connection, scriptId, content);
  return {
    ok: true,
    result: { ok: true, error: null },
  };
}

async function createScript(accountId, name, content) {
  if (!name?.trim()) {
    throw new ProviderError("missingScriptName", "A script name is required.");
  }
  if (!content?.trim()) {
    throw new ProviderError("missingScriptContent", "Script content is required.");
  }

  const connection = await getConnection(accountId);
  const validation = await providers.jmap.validateScript(connection, content);

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
      script: await providers.jmap.createScript(connection, name, content),
    },
  };
}

async function deleteScript(accountId, scriptId) {
  const connection = await getConnection(accountId);
  return {
    ok: true,
    result: await providers.jmap.destroyScript(connection, scriptId),
  };
}

async function setActiveScript(accountId, scriptId) {
  const connection = await getConnection(accountId);
  return {
    ok: true,
    result: await providers.jmap.setActiveScript(connection, scriptId),
  };
}

async function deactivateScript(accountId, scriptId) {
  const connection = await getConnection(accountId);
  return {
    ok: true,
    result: await providers.jmap.deactivateScript(connection, scriptId),
  };
}

async function getConnection(accountId) {
  const account = await getThunderbirdAccount(accountId);
  let config = await storage.getConfig(accountId);

  if (!config) {
    throw new ProviderError("unconfiguredAccount", "This account is not configured for JMAP Sieve.");
  }

  if (config.provider == "tcp") {
    return providers.tcp.discover(config);
  }

  config = await refreshOAuthConfig(accountId, config);
  return discover(account, config);
}

async function refreshOAuthConfig(accountId, config) {
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
  });
  return storage.setConfig(accountId, {
    ...config,
    token: token.accessToken,
    oauthRefreshToken: token.refreshToken || config.oauthRefreshToken,
    oauthExpiresAt: token.expiresAt,
    oauthScope: token.scope || config.oauthScope,
  });
}

async function discover(account, config) {
  return providers.jmap.discover({
    ...config,
    thunderbirdAccount: account,
  });
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
    messengerApi.accounts.list(false),
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
