const test = require("node:test");
const assert = require("node:assert/strict");
const { seedExistingCitizen, startTestServer } = require("../support/test-app");
let server;
let baseUrl;
test.before(async () => ({ server, baseUrl } = await startTestServer()));
test.after(() => new Promise((resolve) => server.close(resolve)));

const post = (path, data, token) =>
  fetch(baseUrl + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(data),
  });

test("real registration and identity routes reject oversized JSON without leaking submitted content", async () => {
  for (const path of [
    "/api/auth/register",
    "/api/auth/login",
    "/api/identity",
    "/API/IDENTITY/",
  ]) {
    const response = await post(path, {
      fullName: "private-fact".repeat(1000),
    });
    assert.equal(response.status, 413);
    assert.deepEqual(await response.json(), {
      error: "Request body exceeds 8 KB.",
    });
  }
});

test("identity save limit applies to the authenticated owner without disabling read or another citizen", async () => {
  const tokens = [];
  for (let index = 0; index < 2; index++) {
    const account = await seedExistingCitizen({
      username: `hardening_${index}_${Date.now()}`,
      password: "FictionalPass123!",
      barangay: "Villamonte",
    });
    tokens.push(account.token);
  }
  assert.equal((await post("/api/identity", {})).status, 401);
  for (let index = 0; index < 20; index++)
    assert.equal(
      (await post("/api/identity", { birthDate: "not-a-date" }, tokens[0]))
        .status,
      400,
    );
  const limited = await post("/api/identity", { userId: 999999 }, tokens[0]);
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get("Retry-After")) > 0);
  assert.equal(
    (await post("/api/identity", { birthDate: "not-a-date" }, tokens[1]))
      .status,
    400,
  );
  assert.equal(
    (
      await fetch(baseUrl + "/api/identity/me", {
        headers: { Authorization: `Bearer ${tokens[0]}` },
      })
    ).status,
    200,
  );
});
