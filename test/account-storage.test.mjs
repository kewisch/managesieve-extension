import assert from "node:assert/strict";
import test from "node:test";

import { AccountStorage } from "../src/background/account-storage.mjs";

function makeStorage(initial = {}) {
  const values = structuredClone(initial);
  return {
    area: {
      async get(defaults) {
        return {
          ...defaults,
          ...values,
        };
      },
      async set(update) {
        Object.assign(values, update);
      },
    },
    values,
  };
}

test("creates manual server accounts with saved JMAP configuration", async () => {
  const { area } = makeStorage();
  const storage = new AccountStorage(area, {
    idGenerator: () => "manual-id",
  });

  const account = await storage.createManualAccount({
    displayName: "External Sieve",
    sessionUrl: "https://sieve.example.net/.well-known/jmap",
    token: "secret-token",
  });

  assert.deepEqual(account, {
    id: "manual:manual-id",
    type: "manual",
    name: "External Sieve",
    identities: [],
  });
  assert.deepEqual(await storage.getManualAccounts(), [account]);
  assert.deepEqual(await storage.getConfig("manual:manual-id"), {
    provider: "jmap",
    authType: "bearer",
    sessionUrl: "https://sieve.example.net/.well-known/jmap",
    token: "secret-token",
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
    displayName: "External Sieve",
  });
});

test("removes a manual account and its saved configuration", async () => {
  const { area } = makeStorage({
    manualAccounts: [
      { id: "manual:one", type: "manual", name: "One", identities: [] },
      { id: "manual:two", type: "manual", name: "Two", identities: [] },
    ],
    accountConfigs: {
      "manual:one": {
        provider: "jmap",
        sessionUrl: "https://one.example.net/.well-known/jmap",
      },
      "manual:two": {
        provider: "jmap",
        sessionUrl: "https://two.example.net/.well-known/jmap",
      },
    },
  });
  const storage = new AccountStorage(area);

  assert.equal(await storage.removeManualAccount("manual:one"), true);
  assert.deepEqual(await storage.getManualAccounts(), [
    { id: "manual:two", type: "manual", name: "Two", identities: [] },
  ]);
  assert.equal(await storage.getConfig("manual:one"), null);
  assert.equal((await storage.getConfig("manual:two")).sessionUrl, "https://two.example.net/.well-known/jmap");
});

test("does not remove non-manual accounts", async () => {
  const { area } = makeStorage({
    manualAccounts: [
      { id: "manual:one", type: "manual", name: "One", identities: [] },
    ],
    accountConfigs: {
      account1: {
        provider: "jmap",
        sessionUrl: "https://mail.example.net/.well-known/jmap",
      },
      "manual:one": {
        provider: "jmap",
        sessionUrl: "https://one.example.net/.well-known/jmap",
      },
    },
  });
  const storage = new AccountStorage(area);

  assert.equal(await storage.removeManualAccount("account1"), false);
  assert.deepEqual(await storage.getManualAccounts(), [
    { id: "manual:one", type: "manual", name: "One", identities: [] },
  ]);
  assert.equal((await storage.getConfig("account1")).sessionUrl, "https://mail.example.net/.well-known/jmap");
});
