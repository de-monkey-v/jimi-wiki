import test from "node:test";
import assert from "node:assert/strict";
import {
  optionalExpectedVersionFromRequest,
  parseExpectedVersion,
  parseModelAccess,
  purgeConfirmationMatches,
  requestsExternalModelScope,
} from "./content-api";

test("modelAccess and expectedVersion input parsing is strict", () => {
  assert.equal(parseModelAccess("external"), "external");
  assert.equal(parseModelAccess("internalOnly"), "internalOnly");
  assert.equal(parseModelAccess(undefined), null);
  assert.equal(parseModelAccess("internal"), null);
  assert.equal(parseExpectedVersion(3), 3);
  assert.equal(parseExpectedVersion(0), null);
  assert.equal(parseExpectedVersion(1.5), null);
  assert.equal(parseExpectedVersion("3"), null);
});

test("external model trust requires the explicit header value", () => {
  assert.equal(requestsExternalModelScope(new Request("http://localhost")), false);
  assert.equal(
    requestsExternalModelScope(
      new Request("http://localhost", { headers: { "X-Jimi-Model-Trust": "external" } }),
    ),
    true,
  );
  assert.equal(
    requestsExternalModelScope(
      new Request("http://localhost", { headers: { "X-Jimi-Model-Trust": "internal" } }),
    ),
    false,
  );
});

test("purge confirmation is an exact slug match", () => {
  assert.equal(
    purgeConfirmationMatches(
      new Request("http://localhost", { headers: { "X-Jimi-Confirm-Purge": "sensitive-source" } }),
      "sensitive-source",
    ),
    true,
  );
  assert.equal(
    purgeConfirmationMatches(
      new Request("http://localhost", { headers: { "X-Jimi-Confirm-Purge": "SENSITIVE-SOURCE" } }),
      "sensitive-source",
    ),
    false,
  );
});

test("legacy DELETE version fallback distinguishes absent, invalid, and conflicting inputs", () => {
  assert.deepEqual(
    optionalExpectedVersionFromRequest(new Request("https://example.test/resource")),
    { state: "absent" },
  );
  assert.deepEqual(
    optionalExpectedVersionFromRequest(new Request("https://example.test/resource?expectedVersion=2")),
    { state: "valid", value: 2 },
  );
  assert.deepEqual(
    optionalExpectedVersionFromRequest(new Request("https://example.test/resource?expectedVersion=abc")),
    { state: "invalid" },
  );
  assert.deepEqual(
    optionalExpectedVersionFromRequest(new Request("https://example.test/resource?expectedVersion=2", {
      headers: { "x-jimi-expected-version": "3" },
    })),
    { state: "invalid" },
  );
});
