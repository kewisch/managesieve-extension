import assert from "node:assert/strict";
import test from "node:test";

import { normalizeJmapSessionUrl } from "../src/background/server-address.mjs";

test("normalizes server addresses to a JMAP well-known session URL", () => {
  assert.equal(normalizeJmapSessionUrl("mail.thundermail.com"), "https://mail.thundermail.com/.well-known/jmap");
  assert.equal(normalizeJmapSessionUrl("https://mail.thundermail.com"), "https://mail.thundermail.com/.well-known/jmap");
  assert.equal(normalizeJmapSessionUrl("https://mail.thundermail.com/"), "https://mail.thundermail.com/.well-known/jmap");
  assert.equal(normalizeJmapSessionUrl("https://mail.thundermail.com/jmap/session"), "https://mail.thundermail.com/jmap/session");
  assert.equal(normalizeJmapSessionUrl(""), "");
});
