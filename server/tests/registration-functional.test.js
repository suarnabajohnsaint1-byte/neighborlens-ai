const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const { create, registration } = require("../../frontend/js/auth/authClient");
const {
  createAuthRateLimit,
} = require("../presentation/http/middleware/authRateLimit.middleware");
const user = {
  id: 7,
  username: "fictional",
  role: "citizen",
  barangay: "Villamonte",
  full_name: "Fictional Citizen",
};
function environment(responses) {
  const stored = new Map();
  const calls = [];
  return {
    stored,
    calls,
    sessionStorage: {
      getItem: (key) => stored.get(key),
      setItem: (key, value) => stored.set(key, value),
    },
    fetch: async (url, options) => {
      calls.push({ url, ...options });
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return {
        ok: next.status < 300,
        status: next.status,
        json: async () => { if (next.parseError) throw new SyntaxError('Not JSON'); return next.body; },
      };
    },
  };
}
test("registration sends compatible credentials and stores only the supported safe session", async () => {
  const env = environment([
    { status: 201, body: { token: "fictional-token", user } },
  ]);
  const result = await create(env).register({
    username: user.username,
    password: "FictionalPass123!",
    fullName: user.full_name,
    barangay: user.barangay,
  });
  assert.equal(result.id, 7);
  assert.equal(result.fullName, user.full_name);
  assert.equal(JSON.parse(env.calls[0].body).password, "FictionalPass123!");
  assert.equal(JSON.parse(env.stored.get("up_session")).password, undefined);
});
for (const role of ["citizen", "admin", "barangay"])
  test(`existing ${role} API response supports login without browser hashes`, async () => {
    const env = environment([
      { status: 200, body: { token: "fixture", user: { ...user, role } } },
    ]);
    assert.equal((await create(env).login("fictional", "fixture", role)).role, role);
  });
for (const status of [400, 401, 409, 422, 429, 500, 503])
  test(`HTTP ${status} never creates a local fallback session`, async () => {
    const env = environment([{ status, body: {} }]);
    await assert.rejects(create(env).login("fictional", "fixture"));
    assert.equal(env.stored.size, 0);
  });
for (const portal of ['citizen', 'admin', 'barangay']) {
  test(`${portal} login reports a missing backend route without retrying a legacy endpoint or storing a session`, async () => {
    const env = environment([{ status: 404, parseError: true }]);
    await assert.rejects(create(env).login('fictional', 'fixture', portal), error => {
      assert.equal(error.status, 404);
      assert.match(error.message, /Authentication endpoint unavailable.*Restart the API server/);
      assert.doesNotMatch(error.message, /registration/);
      return true;
    });
    assert.equal(env.calls.length, 1);
    assert.equal(env.calls[0].url, `/api/auth/${portal}/login`);
    assert.equal(env.stored.size, 0);
  });
}
test('non-JSON login responses do not show registration recovery instructions or create a session', async () => {
  const env = environment([{ status: 200, parseError: true }]);
  await assert.rejects(create(env).login('fictional', 'fixture'), /authentication server returned an invalid response/);
  assert.equal(env.calls.length, 1); assert.equal(env.stored.size, 0);
});
for (const body of [
  {},
  { token: "fixture", user: { ...user, id: "bad" } },
  { token: "fixture", user: { ...user, role: "owner" } },
])
  test("malformed authentication is not treated as success", async () => {
    const env = environment([{ status: 201, body }]);
    await assert.rejects(create(env).register({}));
    assert.equal(env.stored.size, 0);
  });
test("register requires 201 and citizen role", async () => {
  for (const response of [
    { status: 200, body: { token: "fixture", user } },
    {
      status: 201,
      body: { token: "fixture", user: { ...user, role: "admin" } },
    },
  ])
    await assert.rejects(create(environment([response])).register({}));
});
test("network errors, blocked sessions and remote HTTP remain explicit failures", async () => {
  await assert.rejects(
    create(environment([new TypeError("network")])).login("fixture", "fixture"),
    /Cannot reach/,
  );
  const blocked = environment([
    { status: 200, body: { token: "fixture", user } },
  ]);
  blocked.sessionStorage.setItem = () => {
    throw new Error("blocked");
  };
  await assert.rejects(create(blocked).login("fixture", "fixture"), /storage/);
  const insecure = environment([]);
  insecure.location = { href: "http://example.invalid/login.html" };
  await assert.rejects(create(insecure).login("fixture", "fixture"), /HTTPS/);
  assert.equal(insecure.calls.length, 0);
});
test("identity requests use the bearer token and require a real persisted status", async () => {
  const env = environment([{ status: 200, body: { success: true } }]);
  await assert.rejects(
    create(env).saveIdentity("fixture", { fullName: "Fictional" }),
    /not confirmed/,
  );
  assert.equal(env.calls[0].headers.Authorization, "Bearer fixture");
});
test("duplicate submissions coalesce and failed identity retries do not recreate accounts", async () => {
  let accounts = 0,
    saves = 0;
  const flow = registration({
    register: async () => {
      accounts++;
      return { role: "citizen", apiToken: "fixture" };
    },
    saveIdentity: async () => {
      if (++saves === 1) throw new Error("controlled");
      return { documentValidationStatus: "needs_review" };
    },
  });
  const first = flow.submit({}, {});
  assert.equal(first, flow.submit({}, {}));
  await assert.rejects(first);
  await flow.submit({}, {});
  assert.equal(accounts, 1);
  assert.equal(saves, 2);
});

test("a duplicate username does not authenticate or save identity and a new username can recover", async () => {
  const env = environment([
    { status: 409, body: { error: "Username already exists." } },
    { status: 201, body: { token: "new-citizen-token", user } },
    {
      status: 200,
      body: { identity: { documentValidationStatus: "needs_review" } },
    },
  ]);
  const flow = registration(create(env));
  await assert.rejects(flow.submit({ username: "taken" }, {}), {
    status: 409,
    message: "Username is already registered. Log in or choose another username.",
  });
  assert.equal(flow.account(), null);
  assert.equal(flow.uncertain(), false);
  assert.equal(env.stored.size, 0);
  assert.equal(env.calls.length, 1);
  const result = await flow.submit({ username: user.username }, {});
  assert.equal(result.account.id, user.id);
  assert.equal(result.identity.documentValidationStatus, "needs_review");
  assert.deepEqual(env.calls.map((call) => call.url), [
    "/api/auth/register",
    "/api/auth/register",
    "/api/identity",
  ]);
  assert.equal(env.calls[2].headers.Authorization, "Bearer new-citizen-token");
});
test("ambiguous account outcome requires login recovery and existing-account recovery skips registration", async () => {
  let attempts = 0;
  const flow = registration({
    register: async () => {
      attempts++;
      throw new Error("timeout");
    },
  });
  await assert.rejects(flow.submit({}, {}));
  await assert.rejects(flow.submit({}, {}), /Log in/);
  assert.equal(attempts, 1);
  const recovered = registration(
    {
      saveIdentity: async () => ({ documentValidationStatus: "needs_review" }),
    },
    { role: "citizen", apiToken: "fixture" },
  );
  assert.equal(
    (await recovered.submit({}, {})).identity.documentValidationStatus,
    "needs_review",
  );
});
test("authentication rate limiting ignores spoofed forward headers and expires with controlled time", () => {
  let time = 1000,
    passed = 0,
    rejected = 0;
  const limit = createAuthRateLimit({
    clock: () => time,
    maximum: 2,
    windowMs: 1000,
  });
  const res = {
    set() {},
    status(code) {
      assert.equal(code, 429);
      rejected++;
      return this;
    },
    json() {},
  };
  const req = {
    socket: { remoteAddress: "127.0.0.1" },
    body: { username: "fictional" },
    headers: {},
  };
  for (let index = 0; index < 3; index++) {
    req.headers["x-forwarded-for"] = String(index);
    limit(req, res, () => passed++);
  }
  assert.equal(passed, 2);
  assert.equal(rejected, 1);
  time += 1001;
  limit(req, res, () => passed++);
  assert.equal(passed, 3);
});
function vision(createWorker) {
  const ctx = {
    window: { Tesseract: { createWorker } },
    Tesseract: { createWorker },
    document: {},
    console,
    AbortController,
    setTimeout,
    clearTimeout,
    URL,
  };
  vm.createContext(ctx);
  vm.runInContext(
    fs.readFileSync(
      require.resolve("../../frontend/js/shared/vision.js"),
      "utf8",
    ),
    ctx,
  );
  return ctx;
}
test("OCR worker initialization coalesces and can retry after failure with cleanup", async () => {
  let attempts = 0,
    stops = 0;
  const ctx = vision(async () => {
    if (++attempts === 1) throw new Error("startup");
    return {
      terminate: async () => {
        stops++;
      },
    };
  });
  await assert.rejects(vm.runInContext("ensureTesseract()", ctx));
  await Promise.all([
    vm.runInContext("ensureTesseract()", ctx),
    vm.runInContext("ensureTesseract()", ctx),
  ]);
  assert.equal(attempts, 2);
  await ctx.window.stopIdentityOCR();
  assert.equal(stops, 1);
});
test("recognition retry recovers from worker failure without poisoning the queue", async () => {
  let calls = 0;
  const ctx = vision(async () => ({
    recognize: async () => {
      if (++calls === 1) throw new Error("recognition");
      return { data: { text: "fictional" } };
    },
    terminate: async () => {},
  }));
  await assert.rejects(vm.runInContext("recognizeText('one')", ctx));
  assert.equal(
    (await vm.runInContext("recognizeText('two')", ctx)).data.text,
    "fictional",
  );
});
test("ID image validation rejects spoofed MIME, unsupported types and oversized files", async () => {
  const ctx = vision(async () => ({}));
  await ctx.window.validateIdentityImageFile(
    new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], {
      type: "image/png",
    }),
  );
  await assert.rejects(
    ctx.window.validateIdentityImageFile(
      new Blob(["<svg/>"], { type: "image/png" }),
    ),
    /contents/,
  );
  await assert.rejects(
    ctx.window.validateIdentityImageFile(
      new Blob(["gif"], { type: "image/gif" }),
    ),
    /10 MB/,
  );
  await assert.rejects(
    ctx.window.validateIdentityImageFile({ type: "image/png", size: 10485761 }),
    /10 MB/,
  );
});
test("existing expiry parser reads expiration labels without inventing an expiry", () => {
  const parser = require("../../frontend/js/auth/idIdentityService");
  assert.equal(
    parser.extractIdentityFields("DRIVERS LICENSE\nEXPIRATION DATE: 2030-05-15")
      .expiryDate,
    "05/15/2030",
  );
  assert.equal(parser.extractIdentityFields("DRIVERS LICENSE").expiryDate, "");
  assert.equal(
    parser.extractIdentityFields("PHILSYS NATIONAL ID").expiryDate,
    null,
  );
});

test("OCR preprocessing bounds both portrait and landscape long edges", () => {
  const ctx = vision(async () => ({}));
  ctx.document.createElement = () => ({
    width: 0,
    height: 0,
    getContext: () => ({
      drawImage() {},
      getImageData: () => ({ data: new Uint8Array(0) }),
      putImageData() {},
    }),
  });
  for (const [width, height] of [
    [320, 75000],
    [6000, 4000],
    [1200, 760],
  ]) {
    ctx.imageFixture = { width, height };
    const canvas = vm.runInContext("preprocessForOCR(imageFixture)", ctx);
    assert.ok(canvas.width <= 1400 && canvas.height <= 1400);
    assert.ok(canvas.width > 0 && canvas.height > 0);
  }
});

function identityVision(responses) {
  const modes = [];
  const ctx = vision(async () => ({
    recognize: async (_, options) => {
      modes.push(options.tessedit_pageseg_mode);
      return { data: responses.shift() };
    },
    terminate: async () => {},
  }));
  ctx.window.IdIdentityService = require("../../frontend/js/auth/idIdentityService");
  ctx.Image = class {
    width = 800;
    height = 500;
    set src(value) {
      if (value) Promise.resolve().then(() => this.onload());
    }
  };
  ctx.document.createElement = () => ({
    width: 0,
    height: 0,
    getContext: () => ({
      drawImage() {},
      getImageData: () => ({ data: new Uint8Array(0), width: 0, height: 0 }),
      putImageData() {},
    }),
  });
  return { ctx, modes };
}

const readableIdentity =
  "REPUBLIC OF THE PHILIPPINES\nDRIVERS LICENSE\nFULL NAME: FICTIONAL TEST CITIZEN\nDATE OF BIRTH: 1990/05/15\nADDRESS: VILLAMONTE BACOLOD CITY\nLICENSE NO: N01-23-456789\nEXPIRATION DATE: 2030/05/15";
const idBlob = () =>
  new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], {
    type: "image/png",
  });

test("incomplete ID extraction retries once and retains the selected pass's actual text and confidence", async () => {
  const { ctx, modes } = identityVision([
    { text: "DRIVERS LICENSE\nMIDDLE NOME", confidence: 62 },
    { text: readableIdentity, confidence: 83 },
  ]);
  const result = await ctx.window.verifyGovernmentID(idBlob());
  assert.equal(result.rawText, readableIdentity);
  assert.equal(result.confidence, 83);
  assert.equal(result.valid, true);
  assert.deepEqual(modes, ["6", "11"]);
  await ctx.window.stopIdentityOCR();
});

test("complete readable ID fields avoid unnecessary recognition passes", async () => {
  const { ctx, modes } = identityVision([
    { text: readableIdentity, confidence: 95 },
  ]);
  const result = await ctx.window.verifyGovernmentID(idBlob());
  assert.equal(result.confidence, 95);
  assert.deepEqual(modes, ["6"]);
  await ctx.window.stopIdentityOCR();
});

test("concurrent identity scans retain their own recognized fields", async () => {
  const second = readableIdentity.replace('FICTIONAL TEST CITIZEN', 'ANOTHER SAMPLE CITIZEN')
    .replace('N01-23-456789', 'N02-24-123456');
  const { ctx } = identityVision([
    { text: readableIdentity, confidence: 95 },
    { text: second, confidence: 95 },
  ]);
  const results = await Promise.all([
    ctx.window.verifyGovernmentID(idBlob()),
    ctx.window.verifyGovernmentID(idBlob()),
  ]);
  assert.deepEqual(
    results.map(result => [result.fields.fullName, result.fields.idNumber]),
    [['Fictional Test Citizen', 'N01-23-456789'], ['Another Sample Citizen', 'N02-24-123456']],
  );
  await ctx.window.stopIdentityOCR();
});

test("small ID preprocessing enlarges text while retaining a bounded canvas", () => {
  const ctx = vision(async () => ({}));
  ctx.document.createElement = () => ({
    width: 0,
    height: 0,
    getContext: () => ({ drawImage() {} }),
  });
  ctx.imageFixture = { width: 500, height: 320 };
  const canvas = vm.runInContext("identityCanvas(imageFixture)", ctx);
  assert.equal(canvas.width, 1000);
  assert.equal(canvas.height, 640);
});

function fieldAnchorWords() {
  const words = [];
  const row = (y, values) =>
    values.forEach(([text, x, width = 50]) =>
      words.push({ text, bbox: { x0: x, x1: x + width, y0: y, y1: y + 10 } }),
    );
  row(0, [
    ["DRIVERS", 10],
    ["LICENSE", 70],
  ]);
  row(20, [
    ["FULL", 200, 30],
    ["NAME:", 235, 40],
  ]);
  row(40, [
    ["FICTIONAL", 200, 65],
    ["TEST", 270, 30],
    ["CITIZEN", 305, 50],
  ]);
  row(70, [
    ["Nationality", 200, 70],
    ["Sex", 290, 25],
    ["Date", 340, 30],
    ["of", 375, 10],
    ["Birth", 390, 30],
    ["Weight", 460],
    ["Height", 520],
  ]);
  row(110, [["Address", 200]]);
  row(170, [
    ["License", 200],
    ["No.", 255, 20],
    ["Expiration", 360, 65],
    ["Date", 430, 30],
    ["Agency", 500],
    ["Code", 555, 30],
  ]);
  row(190, [["N01-23-456789", 200, 110]]);
  row(215, [
    ["Blood", 200],
    ["Type", 255, 30],
  ]);
  return words;
}

test("three missing fields use bounded focused OCR rather than another whole-card guess", async () => {
  const document = {
    text: "REPUBLIC OF THE PHILIPPINES DRIVERS LICENSE",
    words: fieldAnchorWords(),
    confidence: 75,
  };
  const { ctx, modes } = identityVision([
    document,
    document,
    { text: "1992 / 04 / 23", confidence: 88 },
    {
      text: "P-7 HILLSIDE ROAD\nEXAMPLE TOWN, SAMPLE PROVINCE",
      confidence: 90,
    },
    { text: "2032/04/23", confidence: 91 },
  ]);
  const result = await ctx.window.verifyGovernmentID(idBlob());
  assert.equal(result.fields.birthDate, "04/23/1992");
  assert.equal(
    result.fields.address,
    "P-7 HILLSIDE ROAD, EXAMPLE TOWN, SAMPLE PROVINCE",
  );
  assert.equal(result.fields.expiryDate, "04/23/2032");
  assert.equal(result.confidence, 75);
  assert.deepEqual(modes, ["6", "11", "6", "6", "6"]);
  await ctx.window.stopIdentityOCR();
});

test("a focused OCR worker failure preserves the actual whole-card fields for review", async () => {
  const document = {
    text: "DRIVERS LICENSE",
    words: fieldAnchorWords(),
    confidence: 75,
  };
  const { ctx } = identityVision([document, document]);
  const result = await ctx.window.verifyGovernmentID(idBlob());
  assert.equal(result.error, undefined);
  assert.equal(result.fields.fullName, "Fictional Test Citizen");
  assert.equal(result.fields.birthDate, "");
  assert.equal(result.fields.address, "");
  await ctx.window.stopIdentityOCR();
});
