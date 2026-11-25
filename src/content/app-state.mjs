import { normalizeJmapSessionUrl } from "../background/server-address.mjs";

// The single place a new transport registers itself with the UI. `inlineValidation`
// marks providers that can validate a script without writing it, which is what the
// editor gates the save and create buttons on.
const PROVIDER_CAPABILITIES = {
  jmap: { inlineValidation: true },
};

export function bindDefaultFormSubmit(form, submitHandler) {
  form.addEventListener("submit", event => {
    event.preventDefault();
    submitHandler();
  });
}

export function buildSidebarModel(accounts, scriptsByAccount = {}) {
  return visibleAccounts(accounts).map(account => ({
    id: account.id,
    name: account.name || account.id,
    type: account.type || "thunderbird",
    items: [
      ...(scriptsByAccount[account.id] || []).map(script => ({
        type: "script",
        accountId: account.id,
        scriptId: script.id,
        label: script.name || script.id,
        isActive: Boolean(script.isActive),
      })),
      {
        type: "new",
        accountId: account.id,
        l10nId: "newScript",
      },
      {
        type: "configure",
        accountId: account.id,
        l10nId: "configure",
      },
    ],
  }));
}

export function getSelectedView(selection) {
  if (!selection) {
    return { type: "empty" };
  }

  if (selection.type == "script") {
    return {
      type: "script",
      accountId: selection.accountId,
      scriptId: selection.scriptId,
    };
  }

  if (selection.type == "addManualServer") {
    return {
      type: "addManualServer",
    };
  }

  return {
    type: selection.type,
    accountId: selection.accountId,
  };
}

export function getInitialSelection(accounts, scriptsByAccount = {}) {
  const firstAccount = accounts[0];
  if (!firstAccount) {
    return null;
  }

  const firstScript = scriptsByAccount[firstAccount.id]?.[0];
  if (firstScript) {
    return {
      accountId: firstAccount.id,
      type: "script",
      scriptId: firstScript.id,
    };
  }

  return {
    accountId: firstAccount.id,
    type: "configure",
  };
}

export function getDiscoveryOrigin(sessionUrl, account) {
  const normalizedSessionUrl = normalizeJmapSessionUrl(sessionUrl);
  if (normalizedSessionUrl) {
    return `${new URL(normalizedSessionUrl).origin}/*`;
  }

  const email = account?.identities?.find(identity => identity.email)?.email;
  const domain = email?.split("@").pop();

  if (!domain) {
    return null;
  }

  return `https://${domain}/*`;
}

export function getDefaultServerAddress(account) {
  const email = account?.identities?.find(identity => identity.email)?.email;
  return email?.split("@").pop() || "";
}

export function getVisibleAuthFieldIds(authType) {
  if (authType == "basic") {
    return ["username", "password"];
  }

  if (authType == "oauth") {
    return [
      "oauthIssuerUrl",
      "oauthAuthorizationUrl",
      "oauthTokenUrl",
      "oauthClientId",
      "oauthScope",
    ];
  }

  return ["token"];
}

export function isSupportedProvider(provider) {
  return Object.hasOwn(PROVIDER_CAPABILITIES, provider || "jmap");
}

export function requiresScriptValidation(config) {
  return PROVIDER_CAPABILITIES[config?.provider || "jmap"]?.inlineValidation ?? false;
}

export function getSetupMode(key, modes = {}, defaultMode = "simple") {
  const mode = modes[key];
  const setupModes = ["simple", "advanced"];
  if (setupModes.includes(mode)) {
    return mode;
  }

  return setupModes.includes(defaultMode) ? defaultMode : "simple";
}

export function getSimpleSetupModel({ account = null, config = {} } = {}) {
  const serverAddress = config.sessionUrl || getDefaultServerAddress(account);
  const placeholderSource = serverAddress || getDefaultServerAddress(account) || "mail.example.com";

  return {
    displayName: config.displayName || account?.name || "",
    serverAddress,
    serverAddressPlaceholder: normalizeJmapSessionUrl(placeholderSource),
  };
}

export function shouldRetryJmapAutodetection({
  error = null,
  previousConfig = {},
  currentConfig = {},
} = {}) {
  if (!error || !isJmapProvider(previousConfig) || !isJmapProvider(currentConfig)) {
    return false;
  }

  const previousSessionUrl = normalizeJmapSessionUrl(previousConfig.sessionUrl);
  const currentSessionUrl = normalizeJmapSessionUrl(currentConfig.sessionUrl);
  return Boolean(previousSessionUrl && currentSessionUrl && previousSessionUrl != currentSessionUrl);
}

export function getAddManualServerActionIds() {
  return ["saveManualServer", "testManualServer"];
}

export function getConfigureActionIds(account) {
  const actionIds = ["testConnection", "saveConfiguration"];

  if (account?.type == "manual") {
    actionIds.unshift("removeManualServer");
  }

  return actionIds;
}

export function getButtonLabelIds(actionId) {
  if (actionId == "setActiveScript") {
    return ["setActiveScript", "deactivateScript"];
  }

  if (actionId == "deactivateScript") {
    return ["deactivateScript", "setActiveScript"];
  }

  return [actionId];
}

export function getDeleteDialogModel(script) {
  return {
    titleId: "deleteDialogTitle",
    messageId: "deleteScriptConfirm",
    messageArgs: [script?.name || script?.id || ""],
    cancelId: "cancel",
    confirmId: "deleteScript",
  };
}

export function getEmptyEditorState(overrides = {}) {
  return {
    content: "",
    originalContent: "",
    script: null,
    error: null,
    status: "",
    cursor: "",
    isSaving: false,
    ...overrides,
  };
}

export function getLoadedEditorState(script, content, status) {
  return getEmptyEditorState({
    content,
    originalContent: content,
    script,
    status,
  });
}

export function canCreateScript(name, content, existingScripts = [], error = null, { validationRequired = true } = {}) {
  const normalizedName = name?.trim();
  if (!normalizedName || !content?.trim() || error && validationRequired) {
    return false;
  }

  return !existingScripts.some(script => script.name?.trim() == normalizedName);
}

export function canSaveScript(isDirty, error, { validationRequired = true } = {}) {
  return Boolean(isDirty && (!error || !validationRequired));
}

export function getEditorActionIds(script) {
  const isNew = !script;
  const actionIds = [];

  if (!isNew && script.isActive) {
    actionIds.push("deactivateScript");
  } else if (!isNew) {
    actionIds.push("setActiveScript");
  }

  if (!isNew) {
    actionIds.push("deleteScript");
  }

  actionIds.push(isNew ? "createScript" : "saveScript");
  return actionIds;
}

export function isScriptActiveAfterRefresh(scriptsByAccount, accountId, scriptId) {
  return Boolean((scriptsByAccount[accountId] || []).find(script => script.id == scriptId)?.isActive);
}

export function hasActiveScriptAfterRefresh(scriptsByAccount, accountId) {
  return (scriptsByAccount[accountId] || []).some(script => script.isActive);
}

export function getActiveScriptIconPath(isActive) {
  return isActive ? "../images/star-sm.svg" : "";
}

export function getServerIconPath() {
  return "../images/mail-secure.svg";
}

export function getAccountDisclosureIconPath() {
  return "../images/arrow-down-12.svg";
}

export function getSidebarItemIcon(item) {
  if (item.type == "new") {
    return "+";
  }

  if (item.type == "configure") {
    return "⚙";
  }

  return "";
}

export function visibleAccounts(accounts) {
  const visibleTypes = new Set(["imap", "pop3", "ews", "manual"]);
  return accounts.filter(account => visibleTypes.has(account.type));
}

function isJmapProvider(config) {
  return (config?.provider || "jmap") == "jmap";
}
