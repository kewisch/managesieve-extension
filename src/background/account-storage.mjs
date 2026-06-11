const CONFIG_KEY = "accountConfigs";
const MANUAL_ACCOUNTS_KEY = "manualAccounts";

export class AccountStorage {
  constructor(storageArea, { idGenerator = () => crypto.randomUUID() } = {}) {
    this.storageArea = storageArea;
    this.idGenerator = idGenerator;
  }

  async getAllConfigs() {
    const stored = await this.storageArea.get({ [CONFIG_KEY]: {} });
    return stored[CONFIG_KEY] || {};
  }

  async getConfig(accountId) {
    const configs = await this.getAllConfigs();
    return configs[accountId] || null;
  }

  async setConfig(accountId, config) {
    const configs = await this.getAllConfigs();
    const provider = config.provider || "jmap";
    configs[accountId] = {
      provider: "jmap",
      authType: provider == "tcp" ? "basic" : "bearer",
      sessionUrl: "",
      token: "",
      username: "",
      password: "",
      oauthIssuerUrl: "",
      oauthAuthorizationUrl: "",
      oauthClientId: "open",
      oauthTokenUrl: "",
      oauthRegistrationUrl: "",
      oauthScope: "",
      oauthRefreshToken: "",
      oauthExpiresAt: null,
      tcpPort: 4190,
      tcpSecurity: "starttls",
      ...config,
    };
    await this.storageArea.set({ [CONFIG_KEY]: configs });
    await this.#updateManualAccountName(accountId, configs[accountId].displayName);
    return configs[accountId];
  }

  async getManualAccounts() {
    const stored = await this.storageArea.get({ [MANUAL_ACCOUNTS_KEY]: [] });
    return stored[MANUAL_ACCOUNTS_KEY] || [];
  }

  async createManualAccount(config) {
    const id = `manual:${this.idGenerator()}`;
    const account = {
      id,
      type: "manual",
      name: config.displayName?.trim() || config.sessionUrl || id,
      identities: [],
    };
    const manualAccounts = await this.getManualAccounts();
    await this.storageArea.set({ [MANUAL_ACCOUNTS_KEY]: [...manualAccounts, account] });
    await this.setConfig(id, config);
    return account;
  }

  async removeManualAccount(accountId) {
    if (!accountId?.startsWith("manual:")) {
      return false;
    }

    const manualAccounts = await this.getManualAccounts();
    const updatedAccounts = manualAccounts.filter(account => account.id != accountId);

    if (updatedAccounts.length == manualAccounts.length) {
      return false;
    }

    const configs = await this.getAllConfigs();
    delete configs[accountId];
    await this.storageArea.set({
      [MANUAL_ACCOUNTS_KEY]: updatedAccounts,
      [CONFIG_KEY]: configs,
    });
    return true;
  }

  async #updateManualAccountName(accountId, displayName) {
    if (!accountId?.startsWith("manual:") || !displayName?.trim()) {
      return;
    }

    const manualAccounts = await this.getManualAccounts();
    const updatedAccounts = manualAccounts.map(account => {
      if (account.id != accountId) {
        return account;
      }

      return {
        ...account,
        name: displayName.trim(),
      };
    });

    await this.storageArea.set({ [MANUAL_ACCOUNTS_KEY]: updatedAccounts });
  }
}
