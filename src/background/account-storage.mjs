export class AccountStorage {
  constructor(storageArea, { idGenerator = () => crypto.randomUUID() } = {}) {
    this.storageArea = storageArea;
    this.idGenerator = idGenerator;
  }

  async getAllConfigs() {
    const stored = await this.storageArea.get({ accountConfigs: {} });
    return stored.accountConfigs || {};
  }

  async getConfig(accountId) {
    const configs = await this.getAllConfigs();
    return configs[accountId] || null;
  }

  async setConfig(accountId, config) {
    const configs = await this.getAllConfigs();
    configs[accountId] = {
      provider: "jmap",
      authType: "bearer",
      sessionUrl: "",
      token: "",
      username: "",
      password: "",
      oauthIssuerUrl: "",
      oauthAuthorizationUrl: "",
      oauthClientId: "open",
      oauthTokenUrl: "",
      oauthScope: "",
      oauthRefreshToken: "",
      oauthExpiresAt: null,
      ...config,
    };
    await this.storageArea.set({ accountConfigs: configs });
    await this.#updateManualAccountName(accountId, configs[accountId].displayName);
    return configs[accountId];
  }

  async getManualAccounts() {
    const stored = await this.storageArea.get({ manualAccounts: [] });
    return stored.manualAccounts || [];
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
    await this.storageArea.set({ manualAccounts: [...manualAccounts, account] });
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
      manualAccounts: updatedAccounts,
      accountConfigs: configs,
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

    await this.storageArea.set({ manualAccounts: updatedAccounts });
  }
}
