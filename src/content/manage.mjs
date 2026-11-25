import {
  bindDefaultFormSubmit,
  buildSidebarModel,
  canCreateScript,
  canSaveScript,
  getAddManualServerActionIds,
  getActiveScriptIconPath,
  getAccountDisclosureIconPath,
  getButtonLabelIds,
  getConfigureActionIds,
  getDeleteDialogModel,
  getEmptyEditorState,
  getEditorActionIds,
  getLoadedEditorState,
  getServerIconPath,
  getSetupMode,
  getSimpleSetupModel,
  getSidebarItemIcon,
  getInitialSelection,
  getDefaultServerAddress,
  getSelectedView,
  hasActiveScriptAfterRefresh,
  isScriptActiveAfterRefresh,
  isSupportedProvider,
  requiresScriptValidation,
  shouldRetryJmapAutodetection,
  visibleAccounts,
} from "./app-state.mjs";
import {
  DEFAULT_OAUTH_SCOPE,
  normalizeClientId,
} from "../background/oauth-client.mjs";

const state = {
  accounts: [],
  configs: {},
  scriptsByAccount: {},
  selected: null,
  editor: getEmptyEditorState(),
  setupModes: {},
  setupDrafts: {},
  setupErrors: {},
  isDetecting: false,
};
let statusFadeTimer = null;
let autoValidationTimer = null;
let autoValidationToken = 0;

const sidebar = document.getElementById("accountSidebar");
const contentArea = document.getElementById("contentArea");
const welcomeBanner = document.getElementById("welcomeBanner");
const addServerButton = document.getElementById("addServerButton");
const refreshAccountsButton = document.getElementById("refreshAccountsButton");

localizeDocument();
if (globalThis.location?.search == "?welcome") {
  welcomeBanner.hidden = false;
}
addServerButton.addEventListener("click", () => selectAddManualServer());
refreshAccountsButton.addEventListener("click", () => loadAccounts());
await loadAccounts();

async function loadAccounts() {
  cancelAutoValidation();
  renderLoading();
  const response = await sendMessage({ type: "managesieve.getAccounts" });
  if (!response.ok) {
    renderError(response.error);
    return;
  }

  state.accounts = visibleAccounts(response.accounts || []);
  state.configs = response.configs || {};
  state.scriptsByAccount = {};

  for (const account of state.accounts) {
    if (state.configs[account.id]) {
      await refreshScripts(account.id, false);
    }
  }

  if (!state.selected) {
    state.selected = getInitialSelection(state.accounts, state.scriptsByAccount);
    if (state.selected?.type == "script") {
      await loadScript(state.selected.accountId, state.selected.scriptId);
      return;
    }
  }

  render();
}

async function refreshScripts(accountId, rerender = true) {
  const response = await sendMessage({ type: "managesieve.listScripts", accountId });
  if (response.ok) {
    state.scriptsByAccount[accountId] = response.scripts || [];
  } else {
    state.scriptsByAccount[accountId] = [];
  }

  if (rerender) {
    render();
  }
}

function render() {
  renderSidebar();

  const view = getSelectedView(state.selected);
  if (view.type == "addManualServer") {
    renderAddManualServerView();
  } else if (view.type == "configure") {
    renderConfigureView(view.accountId);
  } else if (view.type == "new") {
    renderEditorView(view.accountId, null);
  } else if (view.type == "script") {
    renderEditorView(view.accountId, getScript(view.accountId, view.scriptId));
  } else {
    renderEmptyView();
  }
}

function renderSidebar() {
  sidebar.replaceChildren();
  const model = buildSidebarModel(state.accounts, state.scriptsByAccount, state.configs);

  for (const account of model) {
    const group = document.createElement("section");
    group.className = "account-group";

    const title = document.createElement("div");
    title.className = "account-title";
    const disclosure = document.createElement("img");
    disclosure.className = "account-disclosure";
    disclosure.alt = "";
    disclosure.src = new URL(getAccountDisclosureIconPath(), import.meta.url).toString();

    const accountIcon = document.createElement("img");
    accountIcon.className = "account-icon";
    accountIcon.alt = "";
    accountIcon.src = new URL(getServerIconPath(), import.meta.url).toString();

    const accountName = document.createElement("span");
    accountName.className = "account-name";
    accountName.textContent = account.name;
    title.append(disclosure, accountIcon, accountName);
    group.append(title);

    const items = document.createElement("div");
    items.className = "account-items";

    for (const item of account.items) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "sidebar-item";
      if (isSelected(item)) {
        button.classList.add("selected");
      }

      const label = document.createElement("span");
      label.className = "item-label";
      label.textContent = item.label || message(item.l10nId);

      const utilityIcon = document.createElement("span");
      utilityIcon.className = `item-icon ${item.type}-icon`;
      utilityIcon.textContent = getSidebarItemIcon(item);
      utilityIcon.setAttribute("aria-hidden", "true");

      const marker = document.createElement("span");
      marker.className = "active-marker";
      marker.title = item.isActive ? message("activeScript") : "";
      const activeIconPath = getActiveScriptIconPath(item.isActive);
      if (activeIconPath) {
        const activeIcon = document.createElement("img");
        activeIcon.alt = "";
        activeIcon.src = new URL(activeIconPath, import.meta.url).toString();
        marker.append(activeIcon);
      }

      button.append(utilityIcon, label, marker);
      button.addEventListener("click", () => selectItem(item));
      items.append(button);
    }

    group.append(items);
    sidebar.append(group);
  }
}

function selectAddManualServer() {
  cancelAutoValidation();
  state.selected = { type: "addManualServer" };
  state.editor = getEmptyEditorState();
  render();
}

async function selectItem(item) {
  cancelAutoValidation();
  state.selected = {
    accountId: item.accountId,
    type: item.type,
    scriptId: item.scriptId,
  };
  state.editor = getEmptyEditorState();
  render();

  if (item.type == "script") {
    await loadScript(item.accountId, item.scriptId);
  }
}

async function loadScript(accountId, scriptId) {
  const script = getScript(accountId, scriptId);
  const response = await sendMessage({
    type: "managesieve.loadScript",
    accountId,
    script,
  });

  if (!response.ok) {
    state.editor.error = response.error;
  } else {
    if (response.scripts) {
      state.scriptsByAccount[accountId] = response.scripts;
    }

    state.editor = getLoadedEditorState(response.script || script, response.content || "", message("scriptLoaded"));
  }

  render();
}

function renderConfigureView(accountId) {
  const mode = getSetupMode(
    accountId,
    state.setupModes,
    state.configs[accountId] ? "advanced" : "simple"
  );
  if (mode == "advanced") {
    renderAdvancedConfigureView(accountId);
    return;
  }

  renderSimpleSetupView(accountId);
}

function renderAdvancedConfigureView(accountId) {
  const account = getAccount(accountId);
  const config = getDraftConfig(accountId, state.configs[accountId] || {});
  const rows = [];
  rows.push(["displayNameLabel", input("displayName", config.displayName || account?.name || "")]);
  rows.push(
    ["serverAddressLabel", input("sessionUrl", config.sessionUrl || getDefaultServerAddress(account), message("serverAddressPlaceholder"))],
    ["authTypeLabel", select("authType", config.authType || "bearer", [
      ["bearer", "authBearer"],
      ["basic", "authBasic"],
      ["oauth", "authOAuth"],
    ])],
    ["tokenLabel", input("token", config.token || "", "", "password"), ["bearer"]],
    ["usernameLabel", input("username", config.username || ""), ["basic"]],
    ["passwordLabel", input("password", config.password || "", "", "password"), ["basic"]],
    ["oauthIssuerUrlLabel", input("oauthIssuerUrl", config.oauthIssuerUrl || "", message("oauthIssuerUrlPlaceholder")), ["oauth"]],
    ["oauthAuthorizationUrlLabel", input("oauthAuthorizationUrl", config.oauthAuthorizationUrl || "", message("oauthAuthorizationUrlPlaceholder")), ["oauth"]],
    ["oauthTokenUrlLabel", input("oauthTokenUrl", config.oauthTokenUrl || "", message("oauthTokenUrlPlaceholder")), ["oauth"]],
    ["oauthClientIdLabel", input("oauthClientId", config.oauthClientId || "open"), ["oauth"]],
    ["oauthScopeLabel", input("oauthScope", config.oauthScope || DEFAULT_OAUTH_SCOPE), ["oauth"]],
    ["", buttonRow(getConfigureActionIds(account).map(actionId => button(
      actionId,
      actionId == "testConnection" ? "primary" : actionId == "removeManualServer" ? "danger" : "",
      () => handleConfigureAction(actionId, accountId)
    )))]
  );
  contentArea.replaceChildren(
    header(message("configureTitle", [account?.name || accountId]), []),
    formRowset(rows, () => saveAndTestConfiguration(accountId))
  );
  bindAuthFieldVisibility();
  showSetupError(accountId);
}

function renderAddManualServerView() {
  const mode = getSetupMode("addManualServer", state.setupModes);
  if (mode == "advanced") {
    renderAdvancedAddManualServerView();
    return;
  }

  renderSimpleSetupView(null);
}

function renderAdvancedAddManualServerView() {
  const config = getDraftConfig(null, {});
  contentArea.replaceChildren(
    header(message("addServerTitle"), []),
    formRowset([
      ["displayNameLabel", input("displayName", config.displayName || "", message("displayNamePlaceholder"))],
      ["serverAddressLabel", input("sessionUrl", config.sessionUrl || "", message("serverAddressPlaceholder"))],
      ["authTypeLabel", select("authType", config.authType || "bearer", [
        ["bearer", "authBearer"],
        ["basic", "authBasic"],
        ["oauth", "authOAuth"],
      ])],
      ["tokenLabel", input("token", config.token || "", "", "password"), ["bearer"]],
      ["usernameLabel", input("username", config.username || ""), ["basic"]],
      ["passwordLabel", input("password", config.password || "", "", "password"), ["basic"]],
      ["oauthIssuerUrlLabel", input("oauthIssuerUrl", config.oauthIssuerUrl || "", message("oauthIssuerUrlPlaceholder")), ["oauth"]],
      ["oauthAuthorizationUrlLabel", input("oauthAuthorizationUrl", config.oauthAuthorizationUrl || "", message("oauthAuthorizationUrlPlaceholder")), ["oauth"]],
      ["oauthTokenUrlLabel", input("oauthTokenUrl", config.oauthTokenUrl || "", message("oauthTokenUrlPlaceholder")), ["oauth"]],
      ["oauthClientIdLabel", input("oauthClientId", config.oauthClientId || "open"), ["oauth"]],
      ["oauthScopeLabel", input("oauthScope", config.oauthScope || DEFAULT_OAUTH_SCOPE), ["oauth"]],
      ["", buttonRow(getAddManualServerActionIds().map(actionId => {
        if (actionId == "saveManualServer") {
          return button(actionId, "primary", () => saveManualConnection());
        }

        return button(actionId, "", () => createManualConnection());
      }))],
    ], () => createManualConnection()),
    paragraph("hint", message("addServerHint"))
  );
  bindAuthFieldVisibility();
  showSetupError(null);
}

function renderSimpleSetupView(accountId) {
  const account = accountId ? getAccount(accountId) : null;
  const model = getSimpleSetupModel({
    account,
    config: getDraftConfig(accountId, state.configs[accountId] || {}),
  });
  const continueButton = button("continueSetup", "primary", null, { type: "submit" });
  const advancedButton = button("advancedSettings", "", () => openAdvancedSettings(accountId));
  continueButton.disabled = state.isDetecting;
  advancedButton.disabled = state.isDetecting;

  contentArea.replaceChildren(
    header(accountId ? message("configureTitle", [account?.name || accountId]) : message("addServerTitle"), []),
    formRowset([
      ["displayNameLabel", input("displayName", model.displayName, message("displayNamePlaceholder"))],
      ["serverAddressLabel", input("sessionUrl", model.serverAddress, model.serverAddressPlaceholder)],
      ["", buttonRow([continueButton, advancedButton])],
    ], () => startAutodetection(accountId)),
    paragraph("hint", message(accountId ? "configureAutodetectHint" : "addServerAutodetectHint"))
  );
  if (state.isDetecting) {
    showStatus(message("autodetectingServer"));
  }
  showSetupError(accountId);
}

async function startAutodetection(accountId) {
  const simpleConfig = readSimpleSetupForm(accountId);
  const key = setupKey(accountId);
  let successMessage = "";
  state.setupDrafts[key] = simpleConfig;
  state.setupErrors[key] = null;

  if (!simpleConfig.sessionUrl) {
    state.setupErrors[key] = { message: message("serverAddressRequired") };
    render();
    return;
  }

  state.isDetecting = true;
  render();
  try {
    const discovery = await sendMessage({
      type: "managesieve.discoverJmapOAuthConfig",
      accountId,
      serverAddress: simpleConfig.sessionUrl,
    });
    if (!discovery.ok) {
      openAdvancedSettings(accountId, {
        ...simpleConfig,
        provider: "jmap",
        authType: "oauth",
        ...(discovery.error?.details?.config || {}),
      }, discovery.error);
      return;
    }

    if (!isSupportedProvider(discovery.result.config?.provider)) {
      openAdvancedSettings(accountId, simpleConfig, { message: message("unsupportedProvider") });
      return;
    }

    if (!discovery.result.available) {
      openAdvancedSettings(accountId, {
        ...simpleConfig,
        ...discovery.result.config,
      }, { message: message("jmapUnavailable") });
      return;
    }

    let config = {
      ...simpleConfig,
      ...discovery.result.config,
    };
    state.setupDrafts[key] = config;
    config = await authorizeOAuth(config);
    await saveDetectedConfig(accountId, config);
    successMessage = message("connectionSuccessful");
  } catch (error) {
    openAdvancedSettings(accountId, getDraftConfig(accountId, simpleConfig), error);
  } finally {
    state.isDetecting = false;
    render();
    if (successMessage) {
      showStatus(successMessage);
    }
  }
}

async function saveDetectedConfig(accountId, config) {
  if (accountId) {
    const response = await sendMessage({
      type: "managesieve.saveDetectedConfig",
      accountId,
      config,
    });
    if (!response.ok) {
      throw response.error;
    }

    state.configs[accountId] = response.config || config;
    updateAccountName(accountId, config.displayName);
    state.scriptsByAccount[accountId] = response.scripts || [];
    state.setupModes[accountId] = "advanced";
    state.setupDrafts[accountId] = null;
    state.selected = { accountId, type: "configure" };
    return;
  }

  const response = await sendMessage({
    type: "managesieve.createManualConnection",
    config,
  });
  if (!response.ok) {
    throw response.error;
  }

  state.accounts = [...state.accounts, response.account];
  state.configs[response.account.id] = response.config;
  state.scriptsByAccount[response.account.id] = response.scripts || [];
  state.setupModes.addManualServer = "simple";
  state.setupDrafts.addManualServer = null;
  state.selected = { accountId: response.account.id, type: "configure" };
}

function openAdvancedSettings(accountId, config = getDraftConfig(accountId), error = null) {
  const key = setupKey(accountId);
  state.setupModes[key] = "advanced";
  state.setupDrafts[key] = config;
  state.setupErrors[key] = error;
  render();
}

function readSimpleSetupForm(accountId) {
  return {
    ...getDraftConfig(accountId),
    displayName: document.getElementById("displayName")?.value.trim() || "",
    sessionUrl: document.getElementById("sessionUrl")?.value.trim() || "",
  };
}

function getDraftConfig(accountId, fallback = {}) {
  return state.setupDrafts[setupKey(accountId)] || fallback || {};
}

function setupKey(accountId) {
  return accountId || "addManualServer";
}

function showSetupError(accountId) {
  const error = state.setupErrors[setupKey(accountId)];
  if (error) {
    showInlineError(error);
  }
}

async function saveConfiguration(accountId) {
  const config = readConfigForm();
  const response = await sendMessage({
    type: "managesieve.saveConfig",
    accountId,
    config,
  });

  if (!response.ok) {
    showInlineError(response.error);
    return false;
  }

  state.configs[accountId] = response.config;
  updateAccountName(accountId, response.config.displayName);
  render();
  showStatus(message("settingsSaved"));
  return true;
}

async function saveAndTestConfiguration(accountId) {
  let response = null;
  let config = null;
  try {
    config = readConfigForm();
    if (shouldRetryJmapAutodetection({
      error: state.setupErrors[setupKey(accountId)],
      previousConfig: getDraftConfig(accountId),
      currentConfig: config,
    })) {
      return startAutodetection(accountId);
    }

    if (config.authType == "oauth") {
      config = await authorizeOAuth(config);
    }
    response = await sendMessage({
      type: "managesieve.testConnection",
      accountId,
      config,
    });
  } catch (error) {
    showInlineError(error);
    return;
  }

  if (!response.ok) {
    showInlineError(response.error);
    return;
  }

  state.configs[accountId] = config;
  updateAccountName(accountId, config.displayName);
  state.scriptsByAccount[accountId] = response.scripts || [];
  state.selected = { accountId, type: "configure" };
  render();
  showStatus(message("connectionSuccessful"));
}

async function createManualConnection() {
  let response = null;
  try {
    let config = readConfigForm();
    if (shouldRetryJmapAutodetection({
      error: state.setupErrors[setupKey(null)],
      previousConfig: getDraftConfig(null),
      currentConfig: config,
    })) {
      return startAutodetection(null);
    }

    if (config.authType == "oauth") {
      config = await authorizeOAuth(config);
    }
    response = await sendMessage({
      type: "managesieve.createManualConnection",
      config,
    });
  } catch (error) {
    showInlineError(error);
    return;
  }

  if (!response.ok) {
    showInlineError(response.error);
    return;
  }

  state.accounts = [...state.accounts, response.account];
  state.configs[response.account.id] = response.config;
  state.scriptsByAccount[response.account.id] = response.scripts || [];
  state.selected = { accountId: response.account.id, type: "configure" };
  render();
  showStatus(message("connectionSuccessful"));
}

async function saveManualConnection() {
  const config = readConfigForm();
  const response = await sendMessage({
    type: "managesieve.saveManualConnection",
    config,
  });

  if (!response.ok) {
    showInlineError(response.error);
    return;
  }

  state.accounts = [...state.accounts, response.account];
  state.configs[response.account.id] = response.config;
  state.scriptsByAccount[response.account.id] = response.scripts || [];
  state.selected = { accountId: response.account.id, type: "configure" };
  render();
  showStatus(message("serverSaved"));
}

async function removeManualConnection(accountId) {
  const account = getAccount(accountId);
  if (!globalThis.confirm(message("removeManualServerConfirm", [account?.name || accountId]))) {
    return;
  }

  const response = await sendMessage({
    type: "managesieve.removeManualConnection",
    accountId,
  });

  if (!response.ok) {
    showInlineError(response.error);
    return;
  }

  state.accounts = state.accounts.filter(candidate => candidate.id != accountId);
  delete state.configs[accountId];
  delete state.scriptsByAccount[accountId];
  state.selected = state.accounts.length ? { accountId: state.accounts[0].id, type: "configure" } : null;
  render();
  showStatus(message("serverRemoved"));
}

function renderEditorView(accountId, script) {
  const account = getAccount(accountId);
  const isNew = !script;
  contentArea.replaceChildren();

  let saveButton = null;
  let createButton = null;
  let nameInput = null;
  const existingScripts = state.scriptsByAccount[accountId] || [];
  const validationRequired = requiresScriptValidation(state.configs[accountId]);
  const updateCreateButton = () => {
    if (createButton) {
      createButton.disabled = state.editor.isSaving || !canCreateScript(
        nameInput?.value || "",
        state.editor.content,
        existingScripts,
        state.editor.error,
        { validationRequired }
      );
    }
  };
  const updateSaveButton = () => {
    if (saveButton) {
      saveButton.disabled = state.editor.isSaving ||
        !canSaveScript(isDirty(), state.editor.error, { validationRequired });
    }
  };
  const actions = getEditorActionIds(script).map(actionId => {
    const actionButton = button(
      actionId,
      getEditorActionClass(actionId),
      () => handleEditorAction(actionId, accountId, script)
    );
    if (state.editor.isSaving) {
      actionButton.disabled = true;
    }
    if (actionId == "deleteScript" && script?.isActive) {
      actionButton.disabled = true;
      actionButton.title = message("deleteActiveScriptDisabled");
    }
    if (actionId == "createScript") {
      createButton = actionButton;
      updateCreateButton();
    }
    if (actionId == "saveScript") {
      saveButton = actionButton;
      updateSaveButton();
    }
    return actionButton;
  });

  contentArea.append(header(
    isNew ? message("newScriptTitle", [account?.name || accountId]) : message("scriptTitle", [script.name]),
    actions
  ));

  const editorShell = document.createElement("div");
  editorShell.className = "editor-shell";

  if (isNew) {
    nameInput = input("scriptName", "", message("scriptNamePlaceholder"));
    nameInput.value = state.editor.scriptName || "";
    nameInput.className = "editor-name-input";
    nameInput.disabled = state.editor.isSaving;
    nameInput.addEventListener("input", () => {
      state.editor.scriptName = nameInput.value;
      updateCreateButton();
    });
    editorShell.append(formRowset([["scriptNameLabel", nameInput]]));
    updateCreateButton();
  }

  const meta = document.createElement("div");
  meta.className = "editor-meta";
  const status = document.createElement("span");
  status.id = "editorStatus";
  status.className = "status-line";
  status.textContent = state.editor.status || "";
  const cursor = document.createElement("span");
  cursor.id = "cursorPosition";
  cursor.textContent = state.editor.cursor || message("lineColumn", [1, 1]);
  meta.append(status, cursor);

  const textarea = document.createElement("textarea");
  textarea.id = "scriptEditor";
  textarea.className = "script-editor";
  textarea.spellcheck = false;
  textarea.value = isNew ? state.editor.content : state.editor.content;
  textarea.disabled = state.editor.isSaving;
  textarea.addEventListener("input", () => {
    state.editor.content = textarea.value;
    updateCreateButton();
    updateSaveButton();
    updateCursor(textarea, cursor);
    scheduleAutoValidation(accountId);
  });
  textarea.addEventListener("keyup", () => updateCursor(textarea, cursor));
  textarea.addEventListener("click", () => updateCursor(textarea, cursor));

  editorShell.append(meta, textarea);

  if (state.editor.error) {
    editorShell.append(errorPanel(state.editor.error));
  }

  contentArea.append(editorShell);
  updateCursor(textarea, cursor);
  clearTimeout(statusFadeTimer);
  status.classList.remove("fade-out");
  if (!state.editor.isSaving) {
    scheduleStatusFade(status);
  }
}

async function validateCurrentScript(accountId, { content = state.editor.content, token = null } = {}) {
  const response = await sendMessage({
    type: "managesieve.validateScript",
    accountId,
    content,
  });

  if (token != null && token != autoValidationToken) {
    return;
  }

  handleAutoValidationResponse(response, message("validationSuccessful"));
}

function scheduleAutoValidation(accountId) {
  clearTimeout(autoValidationTimer);
  const token = ++autoValidationToken;
  const content = state.editor.content;
  autoValidationTimer = setTimeout(() => {
    validateCurrentScript(accountId, { content, token });
  }, 1000);
}

function cancelAutoValidation() {
  clearTimeout(autoValidationTimer);
  autoValidationTimer = null;
  autoValidationToken++;
}

async function saveCurrentScript(accountId, script) {
  cancelAutoValidation();

  if (!script) {
    const name = state.editor.scriptName || document.getElementById("scriptName")?.value || "";
    if (!name.trim()) {
      state.editor.error = {
        code: "missingScriptName",
        message: message("scriptNameRequired"),
      };
      state.editor.status = "";
      render();
      return;
    }

    if ((state.scriptsByAccount[accountId] || []).some(candidate => candidate.name?.trim() == name.trim())) {
      state.editor.error = {
        code: "duplicateScriptName",
        message: message("scriptNameAlreadyExists"),
      };
      state.editor.status = "";
      render();
      return;
    }

    if (!state.editor.content.trim()) {
      state.editor.error = {
        code: "missingScriptContent",
        message: message("scriptContentRequired"),
      };
      state.editor.status = "";
      render();
      return;
    }

    const response = await sendSaveMessage({
      type: "managesieve.createScript",
      accountId,
      name,
      content: state.editor.content,
    });

    if (handleValidationResponse(response, message("scriptCreated"))) {
      await refreshScripts(accountId, false);
      state.selected = {
        accountId,
        type: "script",
        scriptId: response.result.script.id,
      };
      await loadScript(accountId, response.result.script.id);
    }
    return;
  }

  const response = await sendSaveMessage({
    type: "managesieve.saveScript",
    accountId,
    scriptId: script.id,
    content: state.editor.content,
  });

  if (handleValidationResponse(response, message("scriptSaved"))) {
    state.editor.originalContent = state.editor.content;
    render();
  }
}

async function sendSaveMessage(messageData) {
  state.editor.isSaving = true;
  state.editor.error = null;
  state.editor.status = message("scriptSaving");
  render();

  try {
    return await sendMessage(messageData);
  } catch (error) {
    return {
      ok: false,
      error: {
        code: "saveFailed",
        message: error?.message || String(error),
      },
    };
  } finally {
    state.editor.isSaving = false;
  }
}

async function deleteScript(accountId, script) {
  cancelAutoValidation();

  if (!script || script.isActive) {
    return;
  }

  if (!await confirmDeleteScript(script)) {
    return;
  }

  const response = await sendMessage({
    type: "managesieve.deleteScript",
    accountId,
    scriptId: script.id,
  });

  if (!response.ok) {
    state.editor.error = response.error;
    state.editor.status = "";
    render();
    return;
  }

  await refreshScripts(accountId, false);
  const nextScript = state.scriptsByAccount[accountId]?.[0] || null;

  if (nextScript) {
    state.selected = {
      accountId,
      type: "script",
      scriptId: nextScript.id,
    };
    await loadScript(accountId, nextScript.id);
    state.editor.status = message("scriptDeleted");
    render();
    return;
  }

  state.selected = { accountId, type: "new" };
  state.editor = getEmptyEditorState({ status: message("scriptDeleted") });
  render();
}

async function setActiveScript(accountId, script) {
  cancelAutoValidation();

  const response = await sendMessage({
    type: "managesieve.setActiveScript",
    accountId,
    scriptId: script.id,
  });

  if (!response.ok) {
    state.editor.error = response.error;
    state.editor.status = "";
    render();
    return;
  }

  await refreshScripts(accountId, false);

  if (!isScriptActiveAfterRefresh(state.scriptsByAccount, accountId, script.id)) {
    state.editor.error = {
      code: "activationNotConfirmed",
      message: message("scriptActivationNotConfirmed"),
    };
    state.editor.status = "";
    render();
    return;
  }

  state.editor.error = null;
  state.editor.status = message("scriptActivated");
  render();
}

async function deactivateScript(accountId, script) {
  cancelAutoValidation();

  const response = await sendMessage({
    type: "managesieve.deactivateScript",
    accountId,
    scriptId: script.id,
  });

  if (!response.ok) {
    state.editor.error = response.error;
    state.editor.status = "";
    render();
    return;
  }

  await refreshScripts(accountId, false);

  if (hasActiveScriptAfterRefresh(state.scriptsByAccount, accountId)) {
    state.editor.error = {
      code: "deactivationNotConfirmed",
      message: message("scriptDeactivationNotConfirmed"),
    };
    state.editor.status = "";
    render();
    return;
  }

  state.editor.error = null;
  state.editor.status = message("scriptDeactivated");
  render();
}

function handleEditorAction(actionId, accountId, script) {
  if (state.editor.isSaving) {
    return;
  }

  if (actionId == "refreshScripts") {
    return refreshScripts(accountId);
  }

  if (actionId == "setActiveScript") {
    return setActiveScript(accountId, script);
  }

  if (actionId == "deactivateScript") {
    return deactivateScript(accountId, script);
  }

  if (actionId == "deleteScript") {
    return deleteScript(accountId, script);
  }

  return saveCurrentScript(accountId, script);
}

function getEditorActionClass(actionId) {
  if (actionId == "createScript" || actionId == "saveScript") {
    return "primary";
  }

  if (actionId == "deleteScript") {
    return "danger";
  }

  return "";
}

function handleConfigureAction(actionId, accountId) {
  if (actionId == "testConnection") {
    return saveAndTestConfiguration(accountId);
  }

  if (actionId == "removeManualServer") {
    return removeManualConnection(accountId);
  }

  return saveConfiguration(accountId);
}

function confirmDeleteScript(script) {
  const model = getDeleteDialogModel(script);
  const dialog = document.createElement("dialog");
  dialog.className = "confirm-dialog";

  const title = document.createElement("h3");
  title.id = "deleteScriptDialogTitle";
  title.textContent = message(model.titleId);
  dialog.setAttribute("aria-labelledby", title.id);

  const description = document.createElement("p");
  description.textContent = message(model.messageId, model.messageArgs);

  const form = document.createElement("form");
  form.method = "dialog";
  form.className = "confirm-dialog-actions";

  const cancelButton = button(model.cancelId, "", () => {});
  cancelButton.type = "submit";
  cancelButton.value = "cancel";
  cancelButton.autofocus = true;

  const confirmButton = button(model.confirmId, "danger", () => {});
  confirmButton.type = "submit";
  confirmButton.value = "confirm";

  form.append(cancelButton, confirmButton);
  dialog.append(title, description, form);
  document.body.append(dialog);

  return new Promise(resolve => {
    dialog.addEventListener("close", () => {
      resolve(dialog.returnValue == "confirm");
      dialog.remove();
    }, { once: true });
    dialog.addEventListener("cancel", () => {
      dialog.returnValue = "cancel";
    });
    dialog.showModal();
  });
}

function handleValidationResponse(response, successMessage) {
  const isValid = applyValidationResponse(response, successMessage);
  render();
  return isValid;
}

function handleAutoValidationResponse(response, successMessage) {
  applyValidationResponse(response, successMessage);
  syncEditorFeedback();
}

function applyValidationResponse(response, successMessage) {
  if (!response.ok) {
    state.editor.error = response.error;
    state.editor.status = "";
    return false;
  }

  if (response.result && !response.result.ok) {
    state.editor.error = {
      code: response.result.error?.type || "invalidSieve",
      message: response.result.error?.description || message("validationFailed"),
      details: response.result.error,
    };
    state.editor.status = "";
    return false;
  }

  state.editor.error = null;
  state.editor.status = successMessage;
  return true;
}

function syncEditorFeedback() {
  const status = document.getElementById("editorStatus");
  if (status) {
    clearTimeout(statusFadeTimer);
    status.classList.remove("fade-out");
    status.textContent = state.editor.status || "";
    scheduleStatusFade(status);
  }

  const editorShell = contentArea.querySelector(".editor-shell");
  if (!editorShell) {
    return;
  }

  editorShell.querySelector(".error-panel")?.remove();
  if (state.editor.error) {
    editorShell.append(errorPanel(state.editor.error));
  }

  const saveButton = contentArea.querySelector('button[data-action-id="saveScript"]');
  if (saveButton) {
    const validationRequired = requiresScriptValidation(state.configs[state.selected?.accountId]);
    saveButton.disabled = state.editor.isSaving ||
      !canSaveScript(isDirty(), state.editor.error, { validationRequired });
  }

  const createButton = contentArea.querySelector('button[data-action-id="createScript"]');
  if (createButton) {
    const accountId = state.selected?.accountId;
    const validationRequired = requiresScriptValidation(state.configs[accountId]);
    createButton.disabled = state.editor.isSaving || !canCreateScript(
      document.getElementById("scriptName")?.value || "",
      state.editor.content,
      state.scriptsByAccount[accountId] || [],
      state.editor.error,
      { validationRequired }
    );
  }
}

function renderEmptyView() {
  contentArea.replaceChildren(
    header(message("emptyTitle"), []),
    paragraph("hint", message("emptyHint"))
  );
}

function renderLoading() {
  contentArea.replaceChildren(
    header(message("loadingTitle"), []),
    paragraph("status-line", message("loadingAccounts"))
  );
}

function renderError(error) {
  contentArea.replaceChildren(
    header(message("errorTitle"), []),
    errorPanel(error)
  );
}

function readConfigForm() {
  return {
    provider: "jmap",
    displayName: document.getElementById("displayName")?.value.trim() || "",
    sessionUrl: document.getElementById("sessionUrl")?.value.trim() || "",
    authType: document.getElementById("authType")?.value || "bearer",
    token: document.getElementById("token")?.value || "",
    username: document.getElementById("username")?.value || "",
    password: document.getElementById("password")?.value || "",
    oauthIssuerUrl: document.getElementById("oauthIssuerUrl")?.value.trim() || "",
    oauthAuthorizationUrl: document.getElementById("oauthAuthorizationUrl")?.value.trim() || "",
    oauthClientId: normalizeClientId(document.getElementById("oauthClientId")?.value),
    oauthTokenUrl: document.getElementById("oauthTokenUrl")?.value.trim() || "",
    oauthScope: document.getElementById("oauthScope")?.value.trim() || DEFAULT_OAUTH_SCOPE,
  };
}

async function authorizeOAuth(config) {
  const response = await sendMessage({
    type: "managesieve.authorizeOAuth",
    config,
  });

  if (!response.ok) {
    throw response.error;
  }

  return response.config;
}

function header(title, actions = []) {
  const container = document.createElement("div");
  container.className = "page-header";
  const h2 = document.createElement("h2");
  h2.textContent = title;
  const toolbar = document.createElement("div");
  toolbar.className = "toolbar";
  toolbar.append(...actions);
  container.append(h2, toolbar);
  return container;
}

function formRowset(rows, defaultSubmitHandler = null) {
  const form = document.createElement(defaultSubmitHandler ? "form" : "div");
  form.className = "form-grid";
  if (defaultSubmitHandler) {
    bindDefaultFormSubmit(form, defaultSubmitHandler);
  }

  for (const [labelId, control, visibilityTokens = null] of rows) {
    const row = document.createElement("div");
    row.className = "setting-row";
    if (labelId) {
      const label = document.createElement("label");
      label.textContent = message(labelId);
      label.htmlFor = control.id;
      const field = document.createElement("div");
      field.className = "field-control";
      field.append(control);
      const descriptionId = getFieldDescriptionId(control.id);
      if (descriptionId) {
        field.append(paragraph("field-description", message(descriptionId)));
      }
      setFieldVisibilityMetadata(row, visibilityTokens);
      row.append(label, field);
      form.append(row);
    } else {
      const spacer = document.createElement("div");
      const fullRow = document.createElement("div");
      fullRow.className = "full-row";
      setFieldVisibilityMetadata(row, visibilityTokens);
      fullRow.append(control);
      row.append(spacer, fullRow);
      form.append(row);
    }
  }

  return form;
}

function getFieldDescriptionId(fieldId) {
  return {
    displayName: "displayNameDescription",
    sessionUrl: "serverAddressDescription",
    authType: "authTypeDescription",
    token: "tokenDescription",
    username: "usernameDescription",
    password: "passwordDescription",
    oauthIssuerUrl: "oauthIssuerUrlDescription",
    oauthAuthorizationUrl: "oauthAuthorizationUrlDescription",
    oauthTokenUrl: "oauthTokenUrlDescription",
    oauthClientId: "oauthClientIdDescription",
    oauthScope: "oauthScopeDescription",
  }[fieldId] || "";
}

function setFieldVisibilityMetadata(element, tokens) {
  const authTypes = tokens?.filter(token => token == "bearer" || token == "basic" || token == "oauth") || [];
  if (authTypes.length) {
    element.dataset.visibleAuthTypes = authTypes.join(" ");
  }
}

function bindAuthFieldVisibility() {
  const authType = document.getElementById("authType");
  if (!authType) {
    return;
  }

  const update = () => updateAuthFieldVisibility(authType.value || "bearer");
  authType.addEventListener("change", update);
  update();
}

function updateAuthFieldVisibility(authType) {
  for (const element of contentArea.querySelectorAll("[data-visible-auth-types]")) {
    const authTypes = element.dataset.visibleAuthTypes.split(" ").filter(Boolean);
    element.hidden = authTypes.length > 0 && !authTypes.includes(authType);
  }
}

function input(id, value, placeholder = "", type = "text") {
  const field = document.createElement("input");
  field.id = id;
  field.type = type;
  field.value = value;
  field.placeholder = placeholder;
  return field;
}

function select(id, value, options) {
  const field = document.createElement("select");
  field.id = id;

  for (const [optionValue, labelId] of options) {
    const option = document.createElement("option");
    option.value = optionValue;
    option.textContent = message(labelId);
    option.selected = optionValue == value;
    field.append(option);
  }

  return field;
}

function button(labelId, className, listener, { type = "button" } = {}) {
  const control = document.createElement("button");
  control.type = type;
  control.className = className;
  control.dataset.actionId = labelId;
  const labelIds = getButtonLabelIds(labelId);

  if (labelIds.length == 1) {
    control.textContent = message(labelId);
  } else {
    control.classList.add("stable-action-label");
    for (const candidateLabelId of labelIds) {
      const label = document.createElement("span");
      label.className = "button-label";
      label.textContent = message(candidateLabelId);
      if (candidateLabelId != labelId) {
        label.classList.add("hidden");
      }
      control.append(label);
    }
  }

  if (listener) {
    control.addEventListener("click", listener);
  }
  return control;
}

function buttonRow(buttons) {
  const row = document.createElement("div");
  row.className = "toolbar";
  row.append(...buttons);
  return row;
}

function paragraph(className, text) {
  const element = document.createElement("p");
  element.className = className;
  element.textContent = text;
  return element;
}

function showInlineError(error) {
  const existing = contentArea.querySelector(".error-panel");
  existing?.remove();
  contentArea.append(errorPanel(error));
}

function showStatus(text) {
  const existing = contentArea.querySelector(".status-line");
  existing?.remove();
  const status = paragraph("status-line", text);
  contentArea.append(status);
  scheduleStatusFade(status);
}

function scheduleStatusFade(status) {
  if (!status?.textContent) {
    return;
  }

  clearTimeout(statusFadeTimer);
  status.classList.remove("fade-out");
  statusFadeTimer = setTimeout(() => {
    status.classList.add("fade-out");
    let didCleanUp = false;
    const cleanUp = () => {
      if (didCleanUp) {
        return;
      }

      didCleanUp = true;
      if (status.id == "editorStatus") {
        status.textContent = "";
        status.classList.remove("fade-out");
        return;
      }

      status.remove();
    };
    status.addEventListener("transitionend", cleanUp, { once: true });
    setTimeout(cleanUp, 480);
  }, 1000);
}

function errorPanel(error) {
  const panel = document.createElement("div");
  panel.className = "error-panel";
  panel.textContent = error?.message || String(error);
  return panel;
}

function isSelected(item) {
  return state.selected?.accountId == item.accountId &&
    state.selected?.type == item.type &&
    (item.type != "script" || state.selected?.scriptId == item.scriptId);
}

function isDirty() {
  return state.editor.content != state.editor.originalContent;
}

function getAccount(accountId) {
  return state.accounts.find(account => account.id == accountId);
}

function getScript(accountId, scriptId) {
  return state.scriptsByAccount[accountId]?.find(script => script.id == scriptId) || null;
}

function updateAccountName(accountId, displayName) {
  if (!displayName) {
    return;
  }

  const account = getAccount(accountId);
  if (account?.type == "manual") {
    account.name = displayName;
  }
}

function updateCursor(textarea, target) {
  const beforeCursor = textarea.value.slice(0, textarea.selectionStart);
  const lines = beforeCursor.split("\n");
  const line = lines.length;
  const column = lines.at(-1).length + 1;
  state.editor.cursor = message("lineColumn", [line, column]);
  target.textContent = state.editor.cursor;
}

function localizeDocument() {
  for (const element of document.querySelectorAll("[data-i18n]")) {
    element.textContent = message(element.dataset.i18n);
  }
  for (const element of document.querySelectorAll("[data-i18n-title]")) {
    element.title = message(element.dataset.i18nTitle);
  }
}

function message(name, substitutions = undefined) {
  return messenger.i18n.getMessage(name, substitutions) || name;
}

async function sendMessage(messageData) {
  return messenger.runtime.sendMessage(messageData);
}
