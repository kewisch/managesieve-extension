import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSidebarModel,
  canCreateScript,
  canSaveScript,
  getInitialSelection,
  getDefaultServerAddress,
  getDiscoveryOrigin,
  getButtonLabelIds,
  getDeleteDialogModel,
  getEditorActionIds,
  getLoadedEditorState,
  getVisibleAuthFieldIds,
  hasActiveScriptAfterRefresh,
  isScriptActiveAfterRefresh,
  visibleAccounts,
} from "../src/content/app-state.mjs";

test("sidebar model lists account scripts followed by new and configure items", () => {
  const model = buildSidebarModel(
    [
      { id: "account1", name: "First Account", type: "imap" },
      { id: "account2", name: "Second Account", type: "pop3" },
    ],
    {
      account1: [
        { id: "script1", name: "before", isActive: false },
        { id: "script2", name: "active", isActive: true },
      ],
    }
  );

  assert.deepEqual(model.map(account => account.id), ["account1", "account2"]);
  assert.deepEqual(model[0].items.map(item => item.type), ["script", "script", "new", "configure"]);
  assert.deepEqual(model[0].items.map(item => item.label ?? item.l10nId), [
    "before",
    "active",
    "newScript",
    "configure",
  ]);
  assert.deepEqual(model[1].items.map(item => item.type), ["new", "configure"]);
});

test("initial selection prefers the first script of the first account", () => {
  assert.deepEqual(
    getInitialSelection(
      [
        { id: "account1", type: "imap" },
        { id: "account2", type: "imap" },
      ],
      {
        account1: [
          { id: "script1", name: "one" },
        ],
        account2: [
          { id: "script2", name: "two" },
        ],
      }
    ),
    { accountId: "account1", type: "script", scriptId: "script1" }
  );
});

test("initial selection falls back to configure when the first account has no scripts", () => {
  assert.deepEqual(
    getInitialSelection(
      [
        { id: "account1", type: "imap" },
        { id: "account2", type: "imap" },
      ],
      {
        account2: [
          { id: "script2", name: "two" },
        ],
      }
    ),
    { accountId: "account1", type: "configure" }
  );
  assert.equal(getInitialSelection([], {}), null);
});

test("discovery origin prefers configured session URL and falls back to identity domain", () => {
  assert.equal(
    getDiscoveryOrigin("https://jmap.example.net/session", { identities: [{ email: "user@example.com" }] }),
    "https://jmap.example.net/*"
  );
  assert.equal(
    getDiscoveryOrigin("mail.thundermail.com", { identities: [{ email: "user@example.com" }] }),
    "https://mail.thundermail.com/*"
  );
  assert.equal(
    getDiscoveryOrigin("", { identities: [{ email: "user@example.com" }] }),
    "https://example.com/*"
  );
  assert.equal(getDiscoveryOrigin("", { identities: [] }), null);
});

test("default server address comes from the account identity domain", () => {
  assert.equal(getDefaultServerAddress({
    identities: [{ email: "user@example.com" }],
  }), "example.com");
  assert.equal(getDefaultServerAddress({
    identities: [{ email: "" }, { email: "user@mail.example.net" }],
  }), "mail.example.net");
  assert.equal(getDefaultServerAddress({ identities: [] }), "");
});

test("visible auth fields match the selected authentication mechanism", () => {
  assert.deepEqual(getVisibleAuthFieldIds("bearer"), ["token"]);
  assert.deepEqual(getVisibleAuthFieldIds("basic"), ["username", "password"]);
  assert.deepEqual(getVisibleAuthFieldIds("oauth"), [
    "oauthIssuerUrl",
    "oauthAuthorizationUrl",
    "oauthTokenUrl",
    "oauthClientId",
    "oauthScope",
  ]);
});

test("visible accounts include mail and manual servers only", () => {
  assert.deepEqual(visibleAccounts([
    { id: "imap1", type: "imap", name: "IMAP" },
    { id: "pop1", type: "pop3", name: "POP" },
    { id: "ews1", type: "ews", name: "Exchange" },
    { id: "local1", type: "local", name: "Local Folders" },
    { id: "rss1", type: "rss", name: "Blogs & News Feeds" },
    { id: "nntp1", type: "nntp", name: "Newsgroups" },
    { id: "manual1", type: "manual", name: "Manual Server" },
  ]).map(account => account.id), ["imap1", "pop1", "ews1", "manual1"]);
});

test("editor actions omit manual validation and show delete for existing scripts", () => {
  assert.deepEqual(getEditorActionIds(null), ["createScript"]);
  assert.deepEqual(
    getEditorActionIds({ id: "inactive", isActive: false }),
    ["setActiveScript", "deleteScript", "saveScript"]
  );
  assert.deepEqual(
    getEditorActionIds({ id: "active", isActive: true }),
    ["deactivateScript", "deleteScript", "saveScript"]
  );
});

test("delete dialog model uses the selected script display name", () => {
  assert.deepEqual(getDeleteDialogModel({ id: "script1", name: "main.siv" }), {
    titleId: "deleteDialogTitle",
    messageId: "deleteScriptConfirm",
    messageArgs: ["main.siv"],
    cancelId: "cancel",
    confirmId: "deleteScript",
  });
  assert.deepEqual(getDeleteDialogModel({ id: "script2", name: "" }).messageArgs, ["script2"]);
});

test("activate and deactivate buttons reserve space for both localized labels", () => {
  assert.deepEqual(getButtonLabelIds("setActiveScript"), ["setActiveScript", "deactivateScript"]);
  assert.deepEqual(getButtonLabelIds("deactivateScript"), ["deactivateScript", "setActiveScript"]);
  assert.deepEqual(getButtonLabelIds("saveScript"), ["saveScript"]);
});

test("loaded editor state clears stale errors for a newly selected script", () => {
  const script = { id: "script2", name: "next.siv" };
  assert.deepEqual(getLoadedEditorState(script, "keep;", "Script loaded"), {
    content: "keep;",
    originalContent: "keep;",
    script,
    error: null,
    status: "Script loaded",
    cursor: "",
  });
});

test("new scripts require both a name and content before create is enabled", () => {
  assert.equal(canCreateScript("name.siv", "keep;"), true);
  assert.equal(canCreateScript("", "keep;"), false);
  assert.equal(canCreateScript("  \n", "keep;"), false);
  assert.equal(canCreateScript("name.siv", ""), false);
  assert.equal(canCreateScript("name.siv", "  \n"), false);
  assert.equal(canCreateScript("name.siv", "keep;", [], { code: "invalidSieve" }), false);
});

test("new scripts cannot reuse an existing script name", () => {
  const scripts = [
    { id: "one", name: "main.siv" },
    { id: "two", name: "archive.siv" },
  ];

  assert.equal(canCreateScript("new.siv", "keep;", scripts), true);
  assert.equal(canCreateScript("main.siv", "keep;", scripts), false);
  assert.equal(canCreateScript("  archive.siv  ", "keep;", scripts), false);
});

test("existing scripts can only be saved when dirty and valid", () => {
  assert.equal(canSaveScript(true, null), true);
  assert.equal(canSaveScript(false, null), false);
  assert.equal(canSaveScript(true, { code: "invalidSieve" }), false);
});

test("refreshed script list confirms whether a selected script is active", () => {
  const scriptsByAccount = {
    account1: [
      { id: "inactive", name: "inactive.siv", isActive: false },
      { id: "active", name: "active.siv", isActive: true },
    ],
  };

  assert.equal(isScriptActiveAfterRefresh(scriptsByAccount, "account1", "active"), true);
  assert.equal(isScriptActiveAfterRefresh(scriptsByAccount, "account1", "inactive"), false);
  assert.equal(isScriptActiveAfterRefresh(scriptsByAccount, "account1", "missing"), false);
  assert.equal(isScriptActiveAfterRefresh(scriptsByAccount, "missingAccount", "active"), false);
});

test("refreshed script list identifies whether any script remains active", () => {
  assert.equal(hasActiveScriptAfterRefresh({
    account1: [
      { id: "one", isActive: false },
      { id: "two", isActive: false },
    ],
  }, "account1"), false);
  assert.equal(hasActiveScriptAfterRefresh({
    account1: [
      { id: "one", isActive: false },
      { id: "two", isActive: true },
    ],
  }, "account1"), true);
  assert.equal(hasActiveScriptAfterRefresh({}, "account1"), false);
});
