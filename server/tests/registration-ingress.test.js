const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { gzipSync } = require("node:zlib");
const {
  createRegistrationIngress,
} = require("../presentation/http/middleware/registrationIngress.middleware");
const {
  createRequestRateLimit,
} = require("../presentation/http/middleware/requestRateLimit.middleware");

test("rate limiter caps memory, expires entries and isolates authenticated users", () => {
  let now = 0;
  let passed = 0;
  let rejected = 0;
  const limiter = createRequestRateLimit({
    clock: () => now,
    maximum: 2,
    capacity: 2,
    windowMs: 1000,
    key: (req) => req.user.id,
  });
  const response = {
    set() {},
    status(code) {
      assert.equal(code, 429);
      rejected++;
      return this;
    },
    json() {},
  };
  const request = (id) => limiter({ user: { id } }, response, () => passed++);
  request(1);
  request(1);
  request(1);
  request(2);
  request(3);
  request(2);
  assert.equal(passed, 4);
  assert.equal(rejected, 2);
  now = 1001;
  request(3);
  assert.equal(passed, 5);
});

test("registration ingress rejects floods before parsing and bounds untrusted bodies", async (t) => {
  const app = express();
  app.use("/limited", createRegistrationIngress({ maximum: 2 }));
  app.use("/body", createRegistrationIngress());
  app.use((req, res) => res.json({ accepted: true }));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, headers = {}) =>
    fetch(url + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body,
    });
  assert.equal((await post("/limited", "{}")).status, 200);
  assert.equal((await post("/limited", "{}")).status, 200);
  const flood = await post("/limited", "{private-unparseable", {
    "X-Forwarded-For": "192.0.2.1",
  });
  assert.equal(flood.status, 429);
  assert.ok(Number(flood.headers.get("Retry-After")) > 0);
  assert.equal(flood.headers.get("Cache-Control"), "no-store");
  const invalid = await post("/body", "{private-unparseable");
  assert.equal(invalid.status, 400);
  assert.deepEqual(await invalid.json(), { error: "Invalid JSON request." });
  assert.equal(
    (await post("/body", JSON.stringify({ address: "x".repeat(8192) }))).status,
    413,
  );
  assert.equal(
    (await post("/body", gzipSync("{}"), { "Content-Encoding": "gzip" }))
      .status,
    415,
  );
  assert.equal((await post("/body", "{}")).status, 200);
  assert.equal(
    (await post("/body", "private-document", { "Content-Type": "text/plain" }))
      .status,
    415,
  );
  assert.equal(
    (await post("/body", "x".repeat(8193), { "Content-Type": "image/png" }))
      .status,
    413,
  );
  assert.equal((await fetch(url + "/limited")).status, 200);
});
