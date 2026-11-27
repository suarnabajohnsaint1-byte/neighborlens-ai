const { fixedBrowserLocation } = require('../support/browser-geolocation');
const { test, expect } = require("@playwright/test");
const sharp = require("sharp");
const fs = require("node:fs/promises");
const path = require("node:path");
const { PNG_BYTES, JPEG_BYTES } = require("../support/image-fixtures");

const text =
  "REPUBLIC OF THE PHILIPPINES\nLAND TRANSPORTATION OFFICE\nDRIVERS LICENSE\nFULL NAME: FICTIONAL TEST CITIZEN\nDATE OF BIRTH: 1990-05-15\nLICENSE NO: N01-23-456789\nADDRESS: VILLAMONTE BACOLOD CITY\nEXPIRATION DATE: 2030-05-15";
let documentImage;
let blank;
const renderLicense = (text, worn = false) => sharp(Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="760"><rect width="1200" height="760" fill="${worn ? "#ded7c5" : "white"}"/>${worn
    ? '<ellipse cx="1010" cy="360" rx="98" ry="130" fill="#c2bdae"/><path d="M930 210l170 295M1038 200l67 270" stroke="#eee9db" stroke-width="3"/>'
    : ''}${text
      .split("\n")
      .map((line, index) => `<text x="45" y="${65 + index * 75}" font-family="Arial" font-size="36" fill="black">${line}</text>`)
      .join("")}</svg>`,
)).png().toBuffer();
test.beforeAll(async () => {
  documentImage = await renderLicense(text);
  blank = await sharp({
    create: { width: 500, height: 320, channels: 3, background: "white" },
  })
    .png()
    .toBuffer();
});
test.beforeEach(async ({ page, context }) => {
  page.errors = [];
  page.on("pageerror", (error) => page.errors.push(error.message));
  await context.addInitScript(() =>
    Object.defineProperty(window, "NEIGHBORLENS_API_BASE_URL", {
      configurable: true,
      get: () => location.origin,
      set() { },
    }),
  );
  await page.goto("/login.html");
  await page.evaluate(() => {
    window.autoDetectBarangay = async () => null;
  });
});
test.afterEach(async ({ page }) => expect(page.errors).toEqual([]));
async function setUploadTestFlag(page, enabled) {
  await page.route('**/js/auth/registrationFlags.js', route => route.fulfill({
    contentType: 'application/javascript',
    body: `window.CITIZEN_ID_UPLOAD_TEST = ${enabled};`
  }));
}
async function signup(page) {
  await page.getByRole("link", { name: "Create Account", exact: true }).click();
  await page.locator("#regBarangay").selectOption("Villamonte");
}
async function installAlignedTestCamera(page, encoded = null, background = '#32302e') {
  await page.evaluate(async ({ payload, background }) => {
    const card = payload ? new Image() : null;
    if (card) {
      card.src = `data:image/png;base64,${payload}`;
      await card.decode();
    }
    window.testCardShift = 0;
    window.testCardScale = 0.82;
    window.testCardPitch = 0;
    window.testCardRoll = 0;
    window.cameraRequests = 0;
    window.testCameraTracks = [];
    navigator.mediaDevices.getUserMedia = async () => {
      window.cameraRequests++;
      const canvas = document.createElement('canvas');
      const resolution = card ? 2 : 1;
      canvas.width = 900 * resolution;
      canvas.height = 700 * resolution;
      const context = canvas.getContext('2d');
      context.scale(resolution, resolution);
      const stream = canvas.captureStream(15);
      window.testCameraTracks.push(stream.getVideoTracks()[0]);
      const paint = () => {
        const video = document.getElementById('idCameraVideo').getBoundingClientRect();
        const guide = document.getElementById('idCardGuide').getBoundingClientRect();
        context.fillStyle = background;
        context.fillRect(0, 0, 900, 700);
        if (!video.width || !guide.width) return;
        const scale = Math.max(video.width / 900, video.height / 700);
        const width = guide.width / scale;
        const height = guide.height / scale;
        const left = (guide.left - video.left) / scale + (900 - video.width / scale) / 2;
        const top = (guide.top - video.top) / scale + (700 - video.height / scale) / 2;
        const inset = (1 - window.testCardScale) / 2;
        const rect = [left + width * (inset + window.testCardShift), top + height * inset,
        width * window.testCardScale, height * window.testCardScale];
        if (card) context.drawImage(card, ...rect);
        else {
          const [x, y, cardWidth, cardHeight] = rect;
          const halfWidth = cardWidth / 2;
          const halfHeight = cardHeight / 2;
          const pitch = window.testCardPitch;
          context.save();
          context.translate(x + halfWidth, y + halfHeight);
          context.rotate(window.testCardRoll * Math.PI / 180);
          context.fillStyle = '#f2eee5';
          context.beginPath();
          context.moveTo(-halfWidth * (1 - pitch), -halfHeight);
          context.lineTo(halfWidth * (1 - pitch), -halfHeight);
          context.lineTo(halfWidth * (1 + pitch), halfHeight);
          context.lineTo(-halfWidth * (1 + pitch), halfHeight);
          context.fill();
          context.restore();
        }
      };
      const timer = setInterval(() => stream.active ? paint() : clearInterval(timer), 60);
      paint();
      return stream;
    };
  }, { payload: encoded, background });
}
async function upload(page, buffer = documentImage) {
  const picker = page.waitForEvent("filechooser");
  await page.locator("#idModeUploadBtn").click();
  await (
    await picker
  ).setFiles({ name: "fictional-id.png", mimeType: "image/png", buffer });
  await expect(page.locator("#govIdPreview")).toBeVisible();
}
async function fixtureOCR(page, overrides = {}) {
  await page.evaluate(
    ({ text, overrides }) => {
      window.verifyGovernmentID = async () => ({
        valid: true,
        score: 55,
        confidence: 92,
        rawText: text,
        ...overrides,
      });
    },
    { text, overrides },
  );
}
async function confirm(page) {
  await expect(page.locator("#regFullName")).toHaveValue(
    /Fictional Test Citizen/i,
  );
  await page.locator("#regFullName").fill("Fictional Corrected Citizen");
  await page.locator("#confirmIdentityBtn").click();
  await expect(page.locator("#signupSubmitBtn")).toBeEnabled();
}
async function credentials(page, username) {
  await page.locator("#regUser").fill(username);
  await page.locator("#regPass").fill("FictionalPass123!");
  await page.locator("#regPassConfirm").fill("FictionalPass123!");
}
async function logout(page, project) {
  if (project === "mobile") await page.locator(".portal-account-toggle").click();
  await page.getByRole("button", { name: "Log out", exact: true }).click();
  await expect(page).toHaveURL(/login.html$/);
  expect(await page.evaluate(() => sessionStorage.getItem("up_session"))).toBeNull();
}
async function savedIdentity(page) {
  const session = await page.evaluate(() => JSON.parse(sessionStorage.getItem("up_session")));
  const response = await page.request.get("/api/identity/me", {
    headers: { Authorization: `Bearer ${session.apiToken}` },
  });
  expect(response.status()).toBe(200);
  return (await response.json()).identity;
}

test("registration map fits the shared barangay outline", async ({ page, context }) => {
  await context.setGeolocation({ latitude: 10.66850, longitude: 122.96470, accuracy: 15 });
  await page.reload();
  await page.route("**/*", route => {
    const url = new URL(route.request().url());
    if (!url.pathname.includes("reverse")) return route.fallback();
    return route.fulfill({ json: { address: { suburb: "Villamonte", city: "Bacolod" } } });
  });
  await page.getByRole("link", { name: "Create Account", exact: true }).click();
  await expect(page.locator("#regBarangay")).toHaveValue("Villamonte");
  await expect(page.locator("#signupGeoCanvas .bacolod-city-outline")).toBeVisible();
  await expect(page.locator("#signupGeoCanvas .bacolod-barangay-outline")).toBeVisible();
  const westEdge = await page.evaluate(async () => {
    const cityOutline = await window.getGeofenceMap("signupGeoCanvas").cityBoundary;
    return cityOutline.getBounds().getWest();
  });
  expect(westEdge).toBeGreaterThan(122.89);
  const fitted = await page.evaluate(() => {
    const { map, inlineOutline } = window.getGeofenceMap("signupGeoCanvas");
    return map.getBounds().contains(inlineOutline.getBounds());
  });
  expect(fitted).toBe(true);
  const readMap = () => page.evaluate(() => {
    const state = window.getGeofenceMap("signupGeoCanvas");
    return { barangay: state.inlineFeature?.properties.name, pin: state.marker.getLatLng().toString() };
  });
  const original = await readMap();
  await page.locator("#regBarangay").selectOption("Estefania");
  await expect.poll(readMap).toEqual({ barangay: "Estefania", pin: original.pin });
  await page.locator("#regBarangay").selectOption("");
  await expect.poll(readMap).toEqual(original);
});

test('Create Account opens and the registration map refreshes on return after a denied fix', async ({ page }) => {
  await page.reload();
  await page.evaluate(() => {
    window.signupFixRequests = 0;
    navigator.geolocation.getCurrentPosition = (success, fail) => {
      if (++window.signupFixRequests === 1) return fail({ code: 1 });
      success({ coords: { latitude: 10.66850, longitude: 122.96470, accuracy: 15 }, timestamp: Date.now() });
    };
    navigator.geolocation.watchPosition = () => 1;
    navigator.geolocation.clearWatch = () => { };
  });
  await page.route('**/api/config/reverse-geocode?*', route => route.fulfill({ json: { address: { suburb: 'Villamonte', city: 'Bacolod City' } } }));
  await page.getByRole('link', { name: 'Create Account', exact: true }).click();
  await expect(page.locator('#signupSection')).toBeVisible();
  await expect(page.getByRole('button', { name: /Retry location/i })).toHaveCount(0);
  await expect(page.locator('#signupGpsStatus')).toContainText('Location permission denied');
  await expect(page.locator('#signupGeoCanvas .bacolod-city-outline')).toBeVisible();
  await page.evaluate(() => {
    window.signupTileRedraws = 0;
    window.getGeofenceMap('signupGeoCanvas').tiles.redraw = () => { window.signupTileRedraws++; };
    document.getElementById('signupMapStatus').hidden = false;
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
    delete document.hidden;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(page.locator('#signupGpsStatus')).toContainText('Location detected');
  await expect(page.locator('#regBarangay')).toHaveValue('Villamonte');
  await expect.poll(() => page.evaluate(() => window.getGeofenceMap('signupGeoCanvas').accuracy?.getRadius())).toBe(15);
  expect(await page.evaluate(() => [window.signupFixRequests, window.signupTileRedraws])).toEqual([2, 1]);
});

for (const workflow of ['registration', 'reporting']) {
  test(`${workflow} holds the Villamonte address through drift and follows real movement`, async ({ page }) => {
    const citizen = { id: 71, username: 'geo-fixture', role: 'citizen', barangay: 'Villamonte', apiToken: 'fixture-location-only' };
    await page.addInitScript(({ workflow, citizen }) => {
      const watchers = new Map();
      let nextId = 0;
      const started = Date.now() - 1500;
      const position = (lat, lng, accuracy, offset) => ({ coords: { latitude: lat, longitude: lng, accuracy }, timestamp: started + offset });
      if (workflow === 'reporting') sessionStorage.setItem('up_session', JSON.stringify(citizen));
      navigator.geolocation.getCurrentPosition = success => success(position(10.6685, 122.9647, 18, 0));
      navigator.geolocation.watchPosition = success => { watchers.set(++nextId, success); return nextId; };
      navigator.geolocation.clearWatch = id => watchers.delete(id);
      window.qaWatchCount = () => watchers.size;
      window.qaGps = (lat, lng, accuracy, offset) => Promise.all([...watchers.values()].map(callback => callback(position(lat, lng, accuracy, offset))));
    }, { workflow, citizen });
    if (workflow === 'reporting') {
      await page.route('**/api/**', route => {
        const path = new URL(route.request().url()).pathname;
        if (path === '/api/me') return route.fulfill({ json: { user: citizen } });
        if (path === '/api/config/report-area') return route.fulfill({ json: { status: 'AUTHORITATIVE_POLYGONS_PENDING' } });
        return route.fulfill({ json: [] });
      });
    }
    let lookups = 0;
    await page.route('**/api/config/reverse-geocode?*', route => {
      lookups++;
      const lng = Number(new URL(route.request().url()).searchParams.get('lon'));
      const barangay = lng < 122.965 ? 'Villamonte' : lng < 122.97 ? 'Mandalagan' : 'Montevista';
      return route.fulfill({ json: { display_name: `Fixture Street, ${barangay}, Bacolod City`, address: { suburb: barangay } } });
    });
    await page.goto(workflow === 'registration' ? '/login.html' : '/citizen.html');
    if (workflow === 'registration') await page.getByRole('link', { name: 'Create Account', exact: true }).click();
    const status = page.locator(workflow === 'registration' ? '#signupGpsStatus' : '#gpsStatus');
    const address = status.locator('.geo-address');
    await expect(address).toHaveText('Fixture Street, Villamonte, Bacolod City');
    await expect.poll(() => page.evaluate(() => window.qaWatchCount())).toBe(1);
    await page.evaluate(async () => {
      await window.qaGps(10.6685, 122.96503, 65, 400);
      await window.qaGps(10.668654, 122.9711347, 9, 200);
    });
    await expect(address).toHaveText('Fixture Street, Villamonte, Bacolod City');
    expect(lookups).toBe(1);
    await page.evaluate(() => window.qaGps(10.668654, 122.9711347, 9, 800));
    await expect(address).toHaveText('Fixture Street, Montevista, Bacolod City');
    expect(lookups).toBe(2);

    if (workflow === 'reporting') {
      await expect(page.locator('#currentBarangay')).toHaveText('Villamonte');
      await page.evaluate(() => showSection('myReportsSection'));
      await expect.poll(() => page.evaluate(() => window.qaWatchCount())).toBe(0);
      await page.evaluate(() => showSection('submitSection'));
    } else {
      await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, value: true });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await expect.poll(() => page.evaluate(() => window.qaWatchCount())).toBe(0);
      await page.evaluate(() => {
        delete document.hidden;
        document.dispatchEvent(new Event('visibilitychange'));
      });
    }
    await expect.poll(() => page.evaluate(() => window.qaWatchCount())).toBe(1);
  });
}

async function loadPinnedOCR(page) {
  const assets = process.env.ENROLLMENT_TEST_BROWSER_ASSETS;
  if (assets) {
    // Use the real pinned OCR worker and English data without depending on CDN availability.
    await page.context().route("**/__test_ocr/**", route => {
      const file = new URL(route.request().url()).pathname.split("/").at(-1);
      const source = file === "eng.traineddata.gz" ? "@tesseract.js-data/eng/4.0.0_best_int"
        : file.startsWith("tesseract-core") ? "tesseract.js-core" : "tesseract.js/dist";
      return route.fulfill({ path: path.join(assets, source, file) });
    });
    const source = await fs.readFile(path.join(__dirname, "../../frontend/js/shared/vision.js"), "utf8");
    const body = source.replace("https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js", "/__test_ocr/tesseract.min.js")
      .replace("Tesseract.createWorker('eng', 1, {", `Tesseract.createWorker('eng', 1, {
            workerPath: location.origin + '/__test_ocr/worker.min.js',
            workerBlobURL: false,
            corePath: location.origin + '/__test_ocr',
            langPath: location.origin + '/__test_ocr',`);
    await page.route("**/js/shared/vision.js", route => route.fulfill({ contentType: "application/javascript", body }));
    await page.reload();
    await page.evaluate(() => { window.autoDetectBarangay = async () => null; });
  }
}

test("citizen credentials cannot submit before the authentication handler loads", async ({ page }) => {
  const resume = Promise.withResolvers();
  await page.route("**/js/auth/auth.js", async route => {
    await resume.promise;
    await route.continue();
  });
  await page.reload({ waitUntil: "commit" });
  try {
    await expect(page.locator("#loginForm")).toHaveAttribute("method", "post");
    await expect(page.locator("#signupForm")).toHaveAttribute("method", "post");
    await expect(page.locator("#citizenLoginSubmit")).toBeDisabled();
  } finally {
    resume.resolve();
  }
  await expect(page.locator("#citizenLoginSubmit")).toBeEnabled();
});

test("basic MySQL enrollment with live scanner and OCR", async ({ page }, info) => {
  test.skip(process.env.NEIGHBORLENS_BASIC_E2E !== "1", "Run with the isolated MySQL enrollment harness.");
  const outside = process.env.NEIGHBORLENS_OUTSIDE_ENROLLMENT === "true";
  await page.context().setGeolocation(
    {
      latitude: outside ? 14.59 : 10.66850,
      longitude: outside ? 120.98 : 122.96470,
      accuracy: 15,
    }
  )
  await loadPinnedOCR(page);
  const assets = process.env.ENROLLMENT_TEST_BROWSER_ASSETS;
  await signup(page);
  const mobile = info.project.name === "mobile";
  const restrictedPreview = process.env.NEIGHBORLENS_RESTRICTED_PREVIEW === "1";
  const previewSerial = Number(process.env.NEIGHBORLENS_PREVIEW_SERIAL || 456796);
  const offset = Number(process.env.NEIGHBORLENS_BASIC_FIXTURE_OFFSET || 0);
  const serial = (restrictedPreview ? previewSerial : 456788 + offset) + Number(!mobile);
  const number = `N01-23-${serial}`;
  const document = outside ? text.replace("VILLAMONTE BACOLOD CITY", "SYNTHETIC STREET MANILA CITY") : text;
  const image = await renderLicense(document.replace("N01-23-456789", number), !mobile);
  await installAlignedTestCamera(page, image.toString("base64"));
  await page.locator("#idModeCameraBtn").click();
  const capture = page.waitForResponse(response =>
    response.request().method() === "POST" && response.url().endsWith("/api/auth/enrollment/capture"), { timeout: 65000 });
  const captureStarted = performance.now();
  await page.locator("#idCaptureBtn").click();
  expect((await capture).status()).toBe(200);
  await expect(page.locator("#idVerifyStatus")).toHaveAttribute("data-scan-code", "BASIC_REGISTRATION_ELIGIBLE");
  await expect(page.locator("#regIdNumber")).toHaveValue(number);
  await expect(page.locator("#regFullName")).toHaveValue(/Fictional Test Citizen/i);
  await expect(page.locator("#regBirthDate")).toHaveValue("1990-05-15");
  await expect(page.locator("#regDocumentType")).toHaveValue("DRIVERS_LICENSE");
  await expect(page.locator("#regAddress")).toHaveValue(outside ? /Synthetic Street.*Manila City/i : /Villamonte.*Bacolod City/i);
  await expect(page.locator("#idVerifyStatus")).toHaveText("ID captured — identity verification pending.");
  await page.locator("#regFullName").fill("Fictional Corrected Citizen");
  console.log(`${info.project.name} capture-to-autofill: ${Math.round(performance.now() - captureStarted)} ms`);
  if (assets) await page.unroute("**/js/shared/vision.js");
  await page.locator("#confirmIdentityBtn").click();
  await expect(page.locator("#signupCredentials")).toBeVisible();
  const username = restrictedPreview ? `basic_preview_${serial}`
    : `basic_e2e_${info.project.name}${offset ? `_${offset}` : ''}`;
  await credentials(page, username);
  if (outside) await page.locator("#regBarangay").selectOption("");
  const registration = page.waitForResponse(response =>
    response.request().method() === "POST" && response.url().endsWith("/api/auth/register"));
  await page.locator("#signupSubmitBtn").click();
  const created = await registration;
  const responseBody = await created.json().catch(() => ({}));
  expect(
    created.status(),
    `Registration failed: ${responseBody?.code ?? "UNKNOWN"}`
  ).toBe(201);
  await expect(page).toHaveURL(/citizen.html$/);
  const session = await page.evaluate(() => JSON.parse(sessionStorage.getItem("up_session")));
  const portalRequest = (endpoint, { token, body } = {}) => page.evaluate(async ({ endpoint, token, body }) => {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(endpoint, {
      method: body === undefined ? "GET" : "POST",
      headers, body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
    return { status: response.status, json: await response.json().catch(() => null) };
  }, { endpoint, token, body });
  const identity = await portalRequest("/api/identity/me", { token: session.apiToken });
  expect(identity.status).toBe(200);
  expect(identity.json.identity).toMatchObject({ documentValidationStatus: "needs_review", fullName: "Fictional Corrected Citizen" });
  expect(session).toMatchObject({ accountStatus: "ACTIVE_LIMITED", identityStatus: "UNVERIFIED", residencyVerified: false });
  await page.reload();
  await expect(page).toHaveURL(/citizen.html$/);
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem("up_session")))).toEqual(session);
  const login = await portalRequest("/api/auth/citizen/login", {
    body: { username, password: "FictionalPass123!" },
  });
  expect(login.status).toBe(200);
  const { token, user } = login.json;
  expect(user).toMatchObject({ role: "citizen", accountStatus: "ACTIVE_LIMITED", identityStatus: "UNVERIFIED" });
  for (const endpoint of ["/api/reports", "/api/community/posts", "/api/identity", "/api/notifications/stream-ticket"]) {
    const result = await portalRequest(endpoint, { token, body: {} });
    if (restrictedPreview && endpoint !== "/api/reports") {
      expect(result.status).toBe(404);
    } else {
      expect(result.status, endpoint).toBe(403);
      expect(result.json.code).toBe("IDENTITY_VERIFICATION_REQUIRED");
    }
  }
  for (const endpoint of ["/api/admin/users", "/api/barangays/gis"]) {
    expect((await portalRequest(endpoint, { token })).status).toBe(restrictedPreview ? 404 : 403);
  }
});

for (const [scenario, status, code, expected, rawText = 'synthetic ID text', screenContext = false, ocrValid = true, hint] of [
  ['unavailable verifier', 503, 'REGISTRATION_VERIFICATION_UNAVAILABLE', 'Unable to Verify'],
  ['unavailable fraud service', 503, 'REGISTRATION_FRAUD_UNAVAILABLE', 'Unable to Verify'],
  ['unavailable location check', 503, 'REGISTRATION_LOCATION_UNAVAILABLE', 'Unable to Verify'],
  ['outside Bacolod', 403, 'REGISTRATION_OUTSIDE_BACOLOD', 'Unable to Verify'],
  ['monitor photo of UMID', null, null, 'Unable to Verify', 'Unified Multi-Purpose ID', true, true, 'Unified Multi-Purpose ID'],
  ['unreadable OCR', null, null, 'Unable to Verify', 'synthetic ID text', false, false],
]) test(`secure enrollment freezes the scan and explains ${scenario}`, async ({ page }) => {
  let enrollmentRequests = 0;
  const responseReady = Promise.withResolvers();
  await page.route('**/api/auth/enrollment/options', route => route.fulfill({ json: { scanTest: false } }));
  await page.route('**/api/auth/enrollment/start', async route => {
    enrollmentRequests++;
    await responseReady.promise;
    return status === null
      ? route.fulfill({ json: { token: 's'.repeat(43) } })
      : route.fulfill({ status, json: { error: expected, code } });
  });
  if (status === null) {
    await page.route('**/api/auth/enrollment/capture', route => route.fulfill({
      json: {
        decision: 'VERIFICATION_REQUIRED', ocrPrefillAllowed: true,
        screening: { classification: 'UNABLE_TO_ASSESS' }
      }
    }));
  }
  await installAlignedTestCamera(page);
  await page.evaluate(({ text, screenContext, ocrValid }) => {
    window.hasScreenContextInIdCapture = async () => screenContext;
    window.scanRequests = 0;
    window.testCardShift = -0.13;
    window.verifyGovernmentID = async file => {
      window.scanRequests++;
      const photo = await createImageBitmap(file);
      window.scannedAspect = photo.width / photo.height;
      photo.close();
      return new Promise(resolve => {
        window.finishTestOcr = () => resolve({ valid: ocrValid, rawText: text });
      });
    };
  }, { text: rawText, screenContext, ocrValid });
  await signup(page);
  const scannerHint = page.locator('#idEnrollmentDocumentHint');
  const cameraHint = page.locator('#idAlignmentStatus');
  await expect(scannerHint).toBeHidden();
  await expect(cameraHint).toBeHidden();
  await page.locator('#idModeCameraBtn').click();
  await expect(cameraHint).toHaveText('Align the ID inside the outline.');
  await expect(page.locator('#idCameraAreaWrapper')).toBeVisible();
  await expect(scannerHint).toBeHidden();
  await expect(page.locator('#idCaptureBtn')).toBeDisabled();
  await expect(page.locator('#idCardGuide')).toHaveCSS('border-top-color', 'rgb(255, 116, 124)');
  expect(await page.evaluate(() => window.scanRequests)).toBe(0);
  if (scenario === 'unavailable verifier') {
    await page.evaluate(() => { window.testCardShift = 0; window.testCardScale = 0.65; });
    await expect(cameraHint).toHaveText('Move closer. Keep the ID inside the outline.');
    await page.evaluate(() => { window.testCardScale = 0.82; });
    await expect(cameraHint).toHaveText('Image looks soft. Hold steady.');
    await expect(page.locator('#idCaptureBtn')).toBeEnabled();
  }
  await page.evaluate(() => { window.testCardShift = 0; });
  await expect(page.locator('#idCardGuide')).toHaveClass(/is-aligned/);
  await expect(page.locator('#idCardGuide')).toHaveCSS('border-top-color', 'rgb(66, 230, 141)');
  await page.locator('#idCaptureBtn').click();
  try {
    await expect(cameraHint).toHaveText('Please hold for a moment.');
    await expect(page.locator('#idCameraCapturedPreviewWrapper #idCaptureProgress')).toBeVisible();
    await expect(page.locator('#idCapturedImg')).toBeVisible();
    await expect(page.locator('#idCameraAreaWrapper')).toBeHidden();
    expect(await page.evaluate(() => window.testCameraTracks.map(track => track.readyState))).toEqual(['ended']);
    await expect.poll(() => page.evaluate(() => window.scannedAspect)).toBeCloseTo(1.586, 1);
    await page.evaluate(() => window.finishTestOcr());
  } finally {
    responseReady.resolve();
  }
  await expect(page.locator('#idVerifyStatus strong')).toHaveText(expected);
  if (code === 'REGISTRATION_OUTSIDE_BACOLOD') {
    await expect(page.locator('#signupGpsStatus')).toContainText('outside Bacolod');
    await expect(page.locator('#idVerifyStatus')).toContainText('current location to be within Bacolod City');
  }
  await expect(page.locator('#idCaptureProgress')).toBeHidden();
  await expect(cameraHint).toBeHidden();
  await expect(page.locator('#idCapturedImg')).toBeVisible();
  await expect(scannerHint).toBeVisible();
  await expect(page.locator('#identityFields')).toBeHidden();
  await expect(page.locator('#confirmIdentityBtn')).toBeDisabled();
  await expect(page.locator('#idVerifiedStatus')).toBeHidden();
  await expect(page.locator('#signupSubmitBtn')).toBeDisabled();
  expect(await page.evaluate(() => window.cameraRequests)).toBe(1);
  expect(await page.evaluate(() => window.scanRequests)).toBe(1);
  expect(enrollmentRequests).toBe(1);
  if (hint) {
    await expect(page.locator('#idEnrollmentDocumentHint')).toContainText(hint);
    await expect(page.locator('#idVerifyStatus')).toContainText('unsupported for registration');
    await page.locator('#idCameraCapturedPreviewWrapper .btn-thumb-retake').click();
    await expect(scannerHint).toBeHidden();
  }
});

test('camera angle guidance matches the card geometry and uses one bottom label', async ({ page }) => {
  await installAlignedTestCamera(page);
  await signup(page);
  await page.locator('#idModeCameraBtn').click();
  const guide = page.locator('#idCardGuide');
  const hint = guide.locator('#idAlignmentStatus');
  const capture = page.locator('#idCaptureBtn');
  await expect(hint).toBeVisible();
  expect(await guide.evaluate(node => getComputedStyle(node, '::before').content)).toBe('none');
  expect(await hint.evaluate(node => node.getBoundingClientRect().bottom >
    node.parentElement.getBoundingClientRect().top + node.parentElement.clientHeight / 2)).toBe(true);
  await expect(capture).toBeEnabled();

  await page.evaluate(() => { window.testCardPitch = 0.12; });
  await expect(hint).toHaveText('Tilt the top edge slightly toward the camera.');
  await expect(capture).toBeDisabled();
  await expect(guide).not.toHaveClass(/is-aligned/);

  await page.evaluate(() => { window.testCardPitch = -0.12; });
  await expect(hint).toHaveText('Tilt the top edge slightly away from the camera.');
  await expect(capture).toBeDisabled();

  await page.evaluate(() => { window.testCardPitch = 0; window.testCardRoll = 12; });
  await expect(hint).toHaveText('Rotate the ID slightly left.');
  await expect(capture).toBeDisabled();

  await page.evaluate(() => { window.testCardRoll = 5; window.testCardScale = 0.98; });
  await expect(hint).toHaveText('Keep all four corners inside the outline.');
  await expect(capture).toBeDisabled();

  await page.evaluate(() => { window.testCardRoll = 0; window.testCardScale = 0.82; });
  await expect(guide).toHaveClass(/is-aligned/);
  await expect(capture).toBeEnabled();
});

test('shutter rejects sudden movement before the snapshot and keeps the photo after release', async ({ page }) => {
  await installAlignedTestCamera(page);
  await page.evaluate(() => {
    const interval = window.setInterval.bind(window);
    window.setInterval = (callback, delay, ...args) => delay === 150
      ? interval(() => { if (!window.pauseAlignment) callback(...args); }, delay)
      : interval(callback, delay, ...args);
    window.ocrCalls = 0;
    window.verifyGovernmentID = async () => {
      window.ocrCalls++;
      return { valid: true, rawText: 'synthetic ID text' };
    };
  });
  const finish = Promise.withResolvers();
  await page.route('**/api/auth/enrollment/options', route => route.fulfill({ json: { scanTest: true } }));
  await page.route('**/api/auth/enrollment/start', async route => {
    await finish.promise;
    await route.fulfill({ status: 503, json: { code: 'REGISTRATION_FRAUD_UNAVAILABLE' } });
  });
  await signup(page);
  await page.locator('#idModeCameraBtn').click();
  const capture = page.locator('#idCaptureBtn');
  const hint = page.locator('#idAlignmentStatus');
  const photo = page.locator('#idCapturedImg');
  await expect(capture).toBeEnabled();
  try {
    await page.evaluate(async () => {
      window.pauseAlignment = true;
      window.testCardShift = 0.073;
      const video = document.getElementById('idCameraVideo');
      for (let frame = 0; frame < 3; frame++)
        await new Promise(resolve => video.requestVideoFrameCallback(resolve));
    });
    await capture.click();
    await expect(hint).toHaveText('Hold the ID steady.');
    await expect(photo).toBeHidden();
    await expect(capture).toBeDisabled();
    expect(await page.evaluate(() => [window.ocrCalls, window.testCameraTracks[0].readyState])).toEqual([0, 'live']);

    await page.evaluate(() => { window.testCardShift = 0; window.pauseAlignment = false; });
    await expect(capture).toBeEnabled();
    await page.evaluate(() => {
      document.getElementById('idCaptureBtn').click();
      window.testCardShift = 0.9;
    });
    await expect(hint).toHaveText('Please hold for a moment.');
    await expect(photo).toBeVisible();
    expect(await photo.evaluate(async image => {
      await image.decode();
      const sample = document.createElement('canvas');
      sample.width = sample.height = 1;
      const context = sample.getContext('2d');
      context.drawImage(image, image.naturalWidth / 2, image.naturalHeight / 2, 1, 1, 0, 0, 1, 1);
      return context.getImageData(0, 0, 1, 1).data[0];
    })).toBeGreaterThan(220);
    expect(await page.evaluate(() => [window.ocrCalls, window.testCameraTracks[0].readyState])).toEqual([1, 'ended']);
  } finally {
    finish.resolve();
  }
});

test('secure enrollment explains an unavailable camera and supports retry', async ({ page }) => {
  await signup(page);
  await page.evaluate(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      throw new DOMException('Not supported', 'NotSupportedError');
    };
  });
  const scan = page.getByRole('button', { name: 'Scan ID', exact: true });
  await scan.click();
  await expect(page.locator('#idVerifyStatus')).toHaveText(
    'No usable camera could be opened. Connect a camera or open this page on a phone.'
  );
  await expect(page.locator('#idCameraVideo')).toBeHidden();
  await expect(page.locator('#signupSubmitBtn')).toBeDisabled();
  await installAlignedTestCamera(page);
  await scan.click();
  await expect(page.locator('#idCameraVideo')).toBeVisible();
  await expect(page.locator('#idCaptureBtn')).toBeEnabled();
});

test('secure enrollment reads visible screen controls from synthetic evidence', async ({ page }) => {
  const makeImage = async text => (await sharp(Buffer.from(
    `<svg width="940" height="500"><rect width="940" height="500" fill="white"/>
    <text x="55" y="140" font-family="Arial" font-size="46">SYNTHETIC TEST IMAGE</text>
    <text x="55" y="390" font-family="Arial" font-size="46">${text}</text></svg>`
  )).jpeg().toBuffer()).toString('base64');
  const samples = await Promise.all([makeImage('Visit       Share       Save'), makeImage('NAME       DATE       ADDRESS')]);
  const detected = await page.evaluate(async images => {
    const results = [];
    for (const image of images) {
      const frame = await (await fetch(`data:image/jpeg;base64,${image}`)).blob();
      results.push(await window.hasScreenContextInIdCapture(frame));
    }
    return results;
  }, samples);
  expect(detected).toEqual([true, false]);
});

test('retired review tokens are cleared after reopening registration', async ({ page }) => {
  const token = 'm'.repeat(43);
  await page.evaluate(value => sessionStorage.setItem('pending_citizen_enrollment', value), token);
  await page.route('**/api/auth/enrollment/status', route => {
    expect(route.request().headers().authorization).toBe('Bearer ' + token);
    return route.fulfill({
      status: 403, json: {
        code: 'REGISTRATION_PROOF_REQUIRED', error: 'This review application is no longer available.'
      }
    });
  });
  await page.reload();
  await signup(page);
  await expect(page.locator('#idVerifyStatus')).toContainText('This review application is no longer available.');
  await expect(page.locator('#identityFields')).toBeHidden();
  await expect(page.locator('#signupSubmitBtn')).toBeDisabled();
  expect(await page.evaluate(() => sessionStorage.getItem('pending_citizen_enrollment'))).toBeNull();
});

test('public signup ignores the diagnostic upload fragment', async ({ page }) => {
  const origin = new URL(page.url()).origin;
  const publicHost = 'https://neighborlens.example';
  await page.route(`${publicHost}/**`, async route => {
    const url = new URL(route.request().url());
    const response = await page.request.get(new URL(url.pathname + url.search, origin).href);
    await route.fulfill({ response });
  });
  await setUploadTestFlag(page, false);
  await page.goto(`${publicHost}/login.html#id-upload-test`);
  await page.evaluate(() => { window.autoDetectBarangay = async () => null; });
  await signup(page);
  await expect(page.locator('#idModeUploadBtn')).toBeHidden();
  await expect(page.locator('#idUploadAreaWrapper')).toBeHidden();
  await expect(page.locator('#idModeCameraBtn')).toBeVisible();
  await expect(page.locator('#signupCredentials')).toBeHidden();
});

test('local signup also ignores the diagnostic upload fragment', async ({ page }) => {
  await page.goto('/login.html#id-upload-test');
  await page.evaluate(() => { window.autoDetectBarangay = async () => null; });
  await signup(page);
  await expect(page.locator('#idModeUploadBtn')).toBeHidden();
  await expect(page.locator('#idModeCameraBtn')).toHaveText('Scan ID');
  await expect(page.locator('#idEnrollmentDocumentHint')).toBeHidden();
});

test('secure enrollment and the three portal maps share the pinned boundary manifest', async ({ page }) => {
  const version = await page.evaluate(async () => {
    const readPortal = async portal => new DOMParser().parseFromString(
      await (await fetch(`/${portal}.html`)).text(), 'text/html');
    for (const portal of ['admin', 'barangay', 'citizen']) {
      if (!(await readPortal(portal)).querySelector('script[src^="js/map/mapConfig.js?v="]')) return null;
    }
    const barangays = await window.BacolodMap.barangays();
    if (barangays.features.length !== 61) return null;
    const area = await window.BacolodMap.reportAreaAt({ lat: 10.671, lng: 122.960 }, 15);
    if (!area.insideCity) return null;
    return window.BacolodMap.boundaryVersion();
  });
  expect(version).toMatch(/^bacolod-map-reference-v\d+$/);
  const result = await page.request.post('/api/auth/enrollment/start', {
    data: {
      position: { latitude: 10.671, longitude: 122.960, accuracy: 15, timestamp: Date.now() }
    }
  });
  expect(result.ok()).toBe(true);
  expect((await result.json()).boundaryVersion).toBe(version);
});

test('opt-in upload preview shows scan progress and cannot enroll', async ({ page }) => {
  await setUploadTestFlag(page, true);
  await page.goto('/login.html');
  await page.reload();
  const enrollmentRequests = [];
  page.on('request', request => {
    if (request.method() === 'POST' && /\/api\/auth\/(enrollment|register)/.test(request.url()))
      enrollmentRequests.push(request.url());
  });
  await page.evaluate(() => {
    window.autoDetectBarangay = async () => null;
    window.verifyGovernmentID = () => new Promise(resolve => {
      window.finishUploadTest = () => resolve({
        valid: true, rawText: 'SYNTHETIC ID TEXT',
        fields: { idType: 'DRIVERS_LICENSE', fullName: 'Fictional Test Citizen' }
      });
    });
  });
  await signup(page);
  const picker = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Upload ID File' }).click();
  await (await picker).setFiles({ name: 'synthetic.png', mimeType: 'image/png', buffer: documentImage });
  await expect(page.locator('#idCapturedImg')).toBeVisible();
  await expect(page.locator('#idCaptureProgress')).toBeVisible();
  await page.evaluate(() => window.finishUploadTest());
  await expect(page.locator('#idVerifyStatus')).toContainText('Upload test complete');
  await expect(page.locator('#idUploadTestFields')).toContainText('Fictional Test Citizen');
  await expect(page.locator('#identityFields')).toBeHidden();
  await expect(page.locator('#idCaptureProgress')).toBeHidden();
  await expect(page.locator('#signupSubmitBtn')).toBeDisabled();
  expect(enrollmentRequests).toEqual([]);
});

test('signup follows the current polygon fix and preserves an explicit barangay choice', async ({ page }) => {
  await page.reload(); // Use the real signup geolocation handler.
  await page.evaluate(() => {
    const start = Date.now() - 1000;
    let offset = 0;
    window.getCurrentLocation = async () => ({ lat: 10.66842, lng: 122.96557, accuracy: 15, timestamp: start });
    navigator.geolocation.watchPosition = callback => {
      window.qaFix = (latitude, longitude, accuracy) => callback({ coords: { latitude, longitude, accuracy }, timestamp: start + ++offset });
      queueMicrotask(() => window.qaFix(10.66842, 122.96557, 12));
      return 1;
    };
    window.renderGeofenceMap = async () => { };
    window.ReverseGeocode = { lookup: async () => ({ barangay: 'Granada' }) };
  });
  await page.getByRole('link', { name: 'Create Account', exact: true }).click();
  const select = page.locator('#regBarangay');
  await expect(select).toHaveValue('Villamonte');
  await page.evaluate(() => window.qaFix(10.66842, 122.96557, 150));
  await expect(select).toHaveValue('Villamonte');
  await page.evaluate(() => window.qaFix(14.5995, 120.9842, 12));
  await expect(select).toHaveValue('');
  await select.selectOption('Granada');
  await page.evaluate(() => window.qaFix(10.66842, 122.96557, 12));
  await expect(select).toHaveValue('Granada');
  await expect(page.locator('#signupSubmitBtn')).toBeDisabled();
});

test('secure enrollment runs OCR alongside screening and autofills approved ID fields', async ({ page }) => {
  const token = 's'.repeat(43);
  let captures = 0;
  const fraudResult = Promise.withResolvers();
  const issuerStarted = Promise.withResolvers();
  const issuerResult = Promise.withResolvers();
  await page.route('**/api/auth/enrollment/options', route => route.fulfill({ json: { scanTest: false } }));
  await page.route('**/api/auth/enrollment/start', async route => {
    expect(route.request().postDataJSON().position.accuracy).toBeGreaterThan(0);
    await route.fulfill({ json: { token, challenge: 'tilt-left', expiresAt: Date.now() + 120000 } });
  });
  await page.route('**/api/auth/enrollment/capture', async route => {
    captures++;
    expect(route.request().headers().authorization).toBe(`Bearer ${token}`);
    expect(route.request().headers()['content-type']).toMatch(/^multipart\/form-data/);
    expect(route.request().postDataBuffer().toString('latin1').match(/name="frames"/g)).toHaveLength(1);
    if (captures === 1) {
      await fraudResult.promise;
      issuerStarted.resolve();
      await issuerResult.promise;
      return route.fulfill({
        status: 422, json: {
          code: 'REGISTRATION_ID_REVIEW_REQUIRED', error: 'ID requires independent verification.',
          screening: { classification: 'SUSPICIOUS', indicators: ['Possible screen recapture.'] }
        }
      });
    }
    if (captures === 2) return route.fulfill({
      json: {
        decision: 'VERIFICATION_REQUIRED', verificationReason: 'VERIFIER_NOT_CONFIGURED', ocrPrefillAllowed: true,
        screening: { classification: 'UNABLE_TO_ASSESS' }
      }
    });
    if (captures === 3) return route.fulfill({ status: 422, json: { decision: 'BLOCK_INVALID', code: 'REGISTRATION_ID_COUNTERFEIT', error: 'Confirmed counterfeit' } });
    if (captures === 4) return route.fulfill({ status: 422, json: { code: 'REGISTRATION_ID_INVALID', decision: 'BLOCK_INVALID', error: 'Invalid issuer evidence' } });
    return route.fulfill({
      json: {
        decision: 'VERIFIED', ocrPrefillAllowed: true, expiresAt: Date.now() + 300000,
        screening: { classification: 'LOW_RISK' }, facts: {
          documentType: 'DRIVERS_LICENSE', idNumber: 'N01-23-456789', fullName: 'Ana Halimbawa',
          birthDate: '1995-05-09', address: captures === 5 ? '' : '42 TEST STREET, VILLAMONTE, BACOLOD CITY', expiryDate: '2099-01-01'
        }
      }
    });
  });
  await installAlignedTestCamera(page);
  await page.evaluate(() => {
    window.hasScreenContextInIdCapture = async () => false;
    window.syntheticOcrCalls = 0;
    window.verifyGovernmentID = async () => {
      window.syntheticOcrCalls++;
      return {
        valid: window.syntheticOcrCalls !== 2, rawText: 'synthetic scanned text', confidence: 80, score: 70, fields: {
          idType: 'DRIVERS_LICENSE', idNumber: 'N01-23-456789', fullName: 'Ana Sample',
          birthDate: '1995-05-09', address: '42 TEST STREET, MANILA', expiryDate: '2099-01-01'
        }
      };
    };
  });
  await signup(page);
  await expect(page.locator('#idModeUploadBtn')).toBeHidden();
  const takePhoto = async (retake = false) => {
    await page.locator(retake ? '#idCameraCapturedPreviewWrapper .btn-thumb-retake' : '#idModeCameraBtn').click();
    await page.locator('#idCaptureBtn').click();
  };
  await takePhoto();
  try {
    await expect.poll(() => captures).toBe(1);
    await expect(page.locator('#idAlignmentStatus')).toHaveText('Please hold for a moment.');
    expect(await page.evaluate(() => window.syntheticOcrCalls)).toBe(1);
    expect(await page.evaluate(() => window.testCameraTracks[0].readyState)).toBe('ended');
    await expect(page.locator('#idCameraAreaWrapper')).toBeHidden();
    await expect(page.locator('#idCameraCapturedPreviewWrapper #idCaptureProgress')).toBeVisible();
    await expect(page.locator('#identityFields')).toBeVisible();
    await expect(page.locator('#regFullName')).toHaveValue('Ana Sample');
    await expect(page.locator('#regAddress')).toHaveValue('42 TEST STREET, MANILA');
    await expect(page.locator('#regDocumentType')).toHaveValue('DRIVERS_LICENSE');
    await expect(page.locator('#regIdNumber')).toHaveValue('N01-23-456789');
    await expect(page.locator('#identityReviewStatus')).toContainText('not yet verified');
    fraudResult.resolve();
    await issuerStarted.promise;
    await expect(page.locator('#regFullName')).toHaveValue('Ana Sample');
    await expect(page.locator('#idVerifiedStatus')).toBeHidden();
    await expect(page.locator('#confirmIdentityBtn')).toBeDisabled();
    await expect(page.locator('#signupSubmitBtn')).toBeDisabled();
  } finally {
    fraudResult.resolve();
    issuerResult.resolve();
  }
  await expect(page.locator('#idVerifyStatus strong')).toHaveText('Unable to Verify');
  await expect(page.locator('#idVerifyStatus')).toHaveAttribute('data-scan-stage', 'submitEnrollmentCapture');
  await expect(page.locator('#idCapturedImg')).toBeVisible();
  await expect(page.locator('#idCaptureProgress')).toBeHidden();
  await expect(page.locator('#idVerifyStatus')).toHaveAttribute('data-http-status', '422');
  await expect(page.locator('#identityFields')).toBeHidden();
  await expect(page.locator('#regFullName')).toHaveValue('');
  await expect(page.locator('#confirmIdentityBtn')).toBeDisabled();
  await expect(page.locator('#signupSubmitBtn')).toBeDisabled();
  await takePhoto(true);
  await expect(page.locator('#idVerifyStatus strong')).toHaveText('Unable to Verify');
  await expect(page.locator('#regFullName')).toHaveValue('Ana Sample');
  await expect(page.locator('#regFullName')).toBeEditable();
  await expect(page.locator('#idVerifyStatus')).toContainText('Automatic ID verification is unavailable.');
  await expect(page.locator('#signupSubmitBtn')).toBeDisabled();
  await page.locator('#regFullName').fill('Ana Halimbawa');
  for (const [status, detail, retainsDraft] of [
    ['Fake ID', 'This ID failed verification. Please use a genuine government-issued ID.'],
    ['Unable to Verify', 'This ID could not be validated. Please use a current, supported government ID.'],
    ['Unable to Verify', 'We could not verify this ID. Retake the photo or use a supported verification method.', true]
  ]) {
    await takePhoto(true);
    await expect(page.locator('#idVerifyStatus strong')).toHaveText(status);
    await expect(page.locator('#idVerifyStatus div')).toHaveText(detail);
    if (retainsDraft) await expect(page.locator('#identityFields')).toBeVisible();
    else await expect(page.locator('#identityFields')).toBeHidden();
    await expect(page.locator('#regAddress')).toHaveValue(retainsDraft ? '42 TEST STREET, MANILA' : '');
    await expect(page.locator('#regFullName')).toHaveValue(retainsDraft ? 'Ana Sample' : '');
    await expect(page.locator('#signupSubmitBtn')).toBeDisabled();
  }
  await takePhoto(true);
  await expect(page.locator('#regFullName')).toHaveValue('Ana Halimbawa');
  await expect(page.locator('#regAddress')).toHaveValue('42 TEST STREET, VILLAMONTE, BACOLOD CITY');
  await expect(page.locator('#regBirthDate')).toHaveValue('1995-05-09');
  await expect(page.locator('#regDocumentType')).toHaveValue('DRIVERS_LICENSE');
  await expect(page.locator('#regIdNumber')).toHaveValue('N01-23-456789');
  await expect(page.locator('#idVerifyStatus strong')).toHaveText("Valid Driver's License");
  await expect(page.locator('#idVerifyStatus div')).toHaveText('Your ID has been verified. Please review your information below.');
  await expect(page.locator('#idScreeningStatus')).toBeHidden();
  await expect(page.locator('#identityReviewStatus')).toContainText('Check the verified details');
  await expect(page.locator('#regExpiryDate')).toHaveValue('2099-01-01');
  expect(await page.evaluate(() => window.syntheticOcrCalls)).toBe(6);
  expect(captures).toBe(6);
  await page.locator('#confirmIdentityBtn').click();
  await expect(page.locator('#signupSubmitBtn')).toBeEnabled();
  await credentials(page, 'synthetic-browser-enrollment');
  const citizen = {
    id: 10, role: 'citizen', username: 'synthetic-browser-enrollment',
    barangay: 'Villamonte', residencyVerified: true
  };
  await page.route('**/api/**', route => {
    if (new URL(route.request().url()).pathname === '/api/me') {
      expect(route.request().headers().authorization).toBe('Bearer synthetic-auth-token');
      return route.fulfill({ json: { user: citizen } });
    }
    return route.fulfill({ json: [] });
  });
  await page.route('**/api/auth/register', async route => {
    const payload = route.request().postDataJSON();
    expect(payload.token).toBe(token);
    expect(payload.identity.address).toBe('42 TEST STREET, VILLAMONTE, BACOLOD CITY');
    expect(payload.position.accuracy).toBeGreaterThan(0);
    await route.fulfill({
      status: 201, json: {
        token: 'synthetic-auth-token',
        user: citizen,
        identity: { documentValidationStatus: 'pass' }
      }
    });
  });
  let extraIdentityWrites = 0;
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/identity') extraIdentityWrites++;
  });
  const portalSession = page.waitForResponse('**/api/me');
  await page.locator('#signupSubmitBtn').click();
  await expect(page).toHaveURL(/citizen\.html$/);
  expect((await portalSession).ok()).toBe(true);
  await expect(page.locator('#submitSection')).toBeVisible();
  if (await page.locator('.portal-account-toggle').isVisible()) {
    await page.getByRole('button', { name: 'Citizen account' }).click();
  }
  await expect(page.locator('#currentBarangay')).toBeVisible();
  await expect(page.locator('#currentBarangay')).toHaveText('Villamonte');
  expect(extraIdentityWrites).toBe(0);
});
test('live OCR populates labeled names and printed address before a denied GPS fix', async ({ page }) => {
  await page.route('**/api/auth/enrollment/options', route => route.fulfill({ json: { scanTest: false } }));
  let enrollmentRequests = 0;
  await page.route('**/api/auth/enrollment/start', route => {
    enrollmentRequests++;
    return route.abort();
  });
  await installAlignedTestCamera(page);
  await page.evaluate(() => {
    window.getCurrentLocation = () => new Promise((_, reject) => {
      window.denyCaptureLocation = () => reject(new Error('Location permission denied'));
    });
    window.verifyGovernmentID = async () => ({
      valid: true,
      confidence: 88,
      rawText: [
        'LAND TRANSPORTATION OFFICE - DRIVER LICENSE',
        'SURNAME: DE LA CRUZ JR.',
        'GIVEN NAMES: ANA MARIA',
        'MIDDLE NAME: SAN JOSE',
        'DATE OF BIRTH: 1990-05-15',
        'ADDRESS: 42 FICTIONAL STREET',
        'BARANGAY VILLAMONTE, BACOLOD CITY',
        'LICENSE NO: N01-23-900123',
        'EXPIRATION DATE: 2099-01-01'
      ].join('\n')
    });
  });
  await signup(page);
  await page.locator('#idModeCameraBtn').click();
  await page.locator('#idCaptureBtn').click();
  await expect(page.locator('#identityFields')).toBeVisible();
  await expect(page.locator('#regFullName')).toHaveValue('Ana Maria San Jose De La Cruz Jr.');
  await expect(page.locator('#regAddress')).toHaveValue('42 FICTIONAL STREET, BARANGAY VILLAMONTE, BACOLOD CITY');
  await expect(page.locator('#regIdNumber')).toHaveValue('N01-23-900123');
  await expect(page.locator('#regBirthDate')).toHaveValue('1990-05-15');
  await expect(page.locator('#regExpiryDate')).toHaveValue('2099-01-01');
  await expect(page.locator('#confirmIdentityBtn')).toBeDisabled();
  await page.waitForFunction(() => window.denyCaptureLocation);
  await page.evaluate(() => window.denyCaptureLocation());
  await expect(page.locator('#idVerifyStatus')).toContainText('Allow precise location');
  await expect(page.locator('#regIdNumber')).toHaveValue('N01-23-900123');
  await expect(page.locator('#signupSubmitBtn')).toBeDisabled();
  expect(enrollmentRequests).toBe(0);
});

test('a retake discards late OCR from an earlier independently verified capture', async ({ page }) => {
  const facts = {
    documentType: 'DRIVERS_LICENSE', idNumber: 'N01-23-456789', fullName: 'Independently Verified Sample',
    birthDate: '1990-05-15', address: '42 TEST STREET, VILLAMONTE, BACOLOD CITY', expiryDate: '2099-01-01'
  };
  let captures = 0;
  await page.route('**/api/auth/enrollment/options', route => route.fulfill({ json: { scanTest: false } }));
  await page.route('**/api/auth/enrollment/start', route => route.fulfill({ json: { token: 's'.repeat(43) } }));
  await page.route('**/api/auth/enrollment/capture', route => route.fulfill({
    json: ++captures === 1
      ? { decision: 'VERIFIED', ocrPrefillAllowed: true, screening: { classification: 'LOW_RISK' }, facts }
      : {
        decision: 'VERIFICATION_REQUIRED', ocrPrefillAllowed: true, verificationReason: 'VERIFIER_UNAVAILABLE',
        screening: { classification: 'LOW_RISK' }
      }
  }));
  await installAlignedTestCamera(page);
  await page.evaluate(() => {
    let calls = 0;
    const result = (fullName, idNumber, address) => ({
      valid: true, rawText: 'synthetic OCR', fields: {
        idType: 'DRIVERS_LICENSE', fullName, idNumber, address, birthDate: '1990-05-15', expiryDate: '2099-01-01'
      }
    });
    window.verifyGovernmentID = async () => ++calls === 1
      ? new Promise(resolve => {
        window.finishFirstOcr = () => resolve(result('Stale OCR Name', 'N01-23-111111', 'Old Address'));
      })
      : result('New OCR Name', 'N01-23-222222', '');
  });
  await signup(page);
  await page.locator('#idModeCameraBtn').click();
  await page.locator('#idCaptureBtn').click();
  await expect(page.locator('#regFullName')).toHaveValue(facts.fullName);
  await expect(page.locator('#identityReviewStatus')).toContainText('Check the verified details');
  await page.locator('#idCameraCapturedPreviewWrapper .btn-thumb-retake').click();
  await expect(page.locator('#regAddress')).toHaveValue('');
  await expect(page.locator('#regIdNumber')).toHaveValue('');
  await page.locator('#idCaptureBtn').click();
  await expect(page.locator('#regFullName')).toHaveValue('New OCR Name');
  await page.evaluate(() => window.finishFirstOcr());
  await expect(page.locator('#idVerifyStatus')).toContainText('ID verification could not be completed');
  await expect(page.locator('#regFullName')).toHaveValue('New OCR Name');
  await expect(page.locator('#regIdNumber')).toHaveValue('N01-23-222222');
  await expect(page.locator('#regAddress')).toHaveValue('');
  await expect(page.locator('#identityReviewStatus')).toContainText('Address on government ID');
  await expect(page.locator('#signupSubmitBtn')).toBeDisabled();
});

test('cancelled worker requests do not stall the next OCR scan', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const started = Promise.withResolvers();
    let workers = 0;
    let terminated = 0;
    window.Tesseract = {
      async createWorker() {
        const first = ++workers === 1;
        return {
          recognize() {
            if (!first) return Promise.resolve({ data: { text: 'new scan' } });
            started.resolve();
            return new Promise(() => { });
          },
          async terminate() { terminated++; }
        };
      }
    };
    const obsolete = recognizeText('old scan').catch(error => error.message);
    await started.promise;
    const queued = recognizeText('queued old scan').catch(error => error.message);
    await window.stopIdentityOCR();
    const [pending, waiting, fresh] = await Promise.all([obsolete, queued, recognizeText('new scan')]);
    await window.stopIdentityOCR();
    return { pending, waiting, text: fresh.data.text, workers, terminated };
  });
  expect(result).toEqual({
    pending: 'Scan cancelled.', waiting: 'Scan cancelled.',
    text: 'new scan', workers: 2, terminated: 2
  });
});
test('rescanning the same photo preserves corrections and a retake clears them', async ({ page }) => {
  const token = 's'.repeat(43);
  await page.route('**/api/auth/enrollment/options', route => route.fulfill({ json: { scanTest: false } }));
  await page.route('**/api/auth/enrollment/start', route => route.fulfill({
    json: { token, challenge: 'tilt-left', expiresAt: Date.now() + 120000 }
  }));
  await page.route('**/api/auth/enrollment/capture', route => {
    expect(route.request().headers().authorization).toBe(`Bearer ${token}`);
    expect(route.request().headers()['content-type']).toMatch(/^multipart\/form-data/);
    return route.fulfill({
      json: {
        decision: 'VERIFICATION_REQUIRED', ocrPrefillAllowed: true,
        verificationReason: 'VERIFIER_NOT_CONFIGURED', screening: { classification: 'LOW_RISK' }
      }
    });
  });
  await signup(page);
  await expect(page.locator('#idModeUploadBtn')).toBeHidden();
  await installAlignedTestCamera(page);
  await page.evaluate(() => { window.hasScreenContextInIdCapture = async () => false; });
  const fields = {
    idType: 'PHILSYS', idNumber: '9876-5432-1098-7654', fullName: 'Fictional Test Citizen',
    birthDate: '1990-05-15', address: '42 TEST STREET, MANILA', expiryDate: null
  };
  await fixtureOCR(page, { fields });
  await page.locator('#idModeCameraBtn').click();
  await page.locator('#idCaptureBtn').click();
  await expect(page.locator('#idVerifyStatus')).toContainText('Automatic ID verification is unavailable');
  await expect(page.locator('#regBirthDate')).toHaveValue('1990-05-15');
  await expect(page.locator('#regFullName')).toHaveValue('Fictional Test Citizen');
  await expect(page.locator('#regBirthDate')).toHaveValue('1990-05-15');
  await expect(page.locator('#regAddress')).toHaveValue('42 TEST STREET, MANILA');
  await expect(page.locator('#regIdNumber')).toHaveValue('9876-5432-1098-7654');
  await expect(page.locator('#signupSubmitBtn')).toBeDisabled();
  await page.locator('#regFullName').fill('Fictional Reviewed Citizen');
  await page.locator('#regBirthDate').fill('2001-09-15');
  await fixtureOCR(page, { fields: { ...fields, fullName: '', birthDate: '' } });
  await page.locator('#verifyIdBtn').click();
  await expect(page.locator('#verifyIdBtn')).toBeEnabled();
  await expect(page.locator('#regFullName')).toHaveValue('Fictional Reviewed Citizen');
  await expect(page.locator('#regBirthDate')).toHaveValue('2001-09-15');
  await page.locator('#confirmIdentityBtn').click();
  await expect(page.locator('#signupSubmitBtn')).toBeDisabled();
  await page.locator('#idCameraCapturedPreviewWrapper .btn-thumb-retake').click();
  await expect(page.locator('#idCameraVideo')).toBeVisible();
  await expect(page.locator('#regFullName')).toHaveValue('');
  await expect(page.locator('#regBirthDate')).toHaveValue('');
  await expect(page.locator('#signupSubmitBtn')).toBeDisabled();
});
async function captureProvisionalId(page, retake = false, image = null) {
  if (!retake) {
    await page.route('**/api/auth/enrollment/options', route => route.fulfill({ json: { scanTest: false } }));
    await page.route('**/api/auth/enrollment/start', route => route.fulfill({ json: { token: 's'.repeat(43) } }));
    await page.route('**/api/auth/enrollment/capture', route => route.fulfill({
      json: {
        decision: 'VERIFICATION_REQUIRED', ocrPrefillAllowed: true,
        verificationReason: 'VERIFIER_NOT_CONFIGURED', screening: { classification: 'LOW_RISK' }
      }
    }));
  }
  if (!retake || image) {
    await installAlignedTestCamera(page, image ? image.toString('base64') : null);
  }
    await page.locator(retake ? '#idCameraCapturedPreviewWrapper .btn-thumb-retake' : '#idModeCameraBtn').click();
    await page.locator('#idCaptureBtn').click();
    await expect(page.locator('#idVerifyStatus')).toContainText('Automatic ID verification is unavailable', { timeout: 20000 });
  }

  async function captureApprovedId(page) {
    const facts = {
      documentType: 'DRIVERS_LICENSE', idNumber: 'N01-23-456789', fullName: 'Fictional Test Citizen',
      birthDate: '1990-05-15', address: 'VILLAMONTE BACOLOD CITY', expiryDate: '2030-05-15'
    };
    await page.route('**/api/auth/enrollment/options', route => route.fulfill({ json: { scanTest: false } }));
    await page.route('**/api/auth/enrollment/start', route => route.fulfill({ json: { token: 's'.repeat(43) } }));
    await page.route('**/api/auth/enrollment/capture', route => route.fulfill({
      json: {
        decision: 'VERIFIED', ocrPrefillAllowed: true, facts,
        expiresAt: Date.now() + 120000, screening: { classification: 'LOW_RISK' }
      }
    }));
    await installAlignedTestCamera(page);
    await fixtureOCR(page);
    await page.locator('#idModeCameraBtn').click();
    await page.locator('#idCaptureBtn').click();
    await expect(page.locator('#identityReviewStatus')).toContainText('Check the verified details');
  }

  test('delayed OCR cannot overwrite a correction made after the scan started', async ({ page }) => {
    await signup(page);
    await fixtureOCR(page);
    await captureProvisionalId(page);
    await expect(page.locator('#regBirthDate')).toHaveValue('1990-05-15');
    await page.evaluate(() => {
      window.verifyGovernmentID = () => new Promise(resolve => { window.resolveDelayedScan = resolve; });
    });
    await page.locator('#verifyIdBtn').click();
    await expect(page.locator('#regFullName')).toBeDisabled();
    await page.evaluate(() => {
      for (const [id, value] of [['regFullName', 'Fictional Later Correction'], ['regBirthDate', '2001-09-15']]) {
        const input = document.getElementById(id);
        input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
    await page.evaluate(text => window.resolveDelayedScan({ valid: true, score: 55, confidence: 92, rawText: text }), text);
    await expect(page.locator('#verifyIdBtn')).toBeEnabled();
    await expect(page.locator('#regFullName')).toHaveValue('Fictional Later Correction');
    await expect(page.locator('#regBirthDate')).toHaveValue('2001-09-15');
  });
  test('an explicit replacement scan repopulates a deliberately cleared field', async ({ page }) => {
    await signup(page);
    await fixtureOCR(page);
    await captureProvisionalId(page);
    await expect(page.locator('#regFullName')).toHaveValue(/Fictional Test Citizen/i);
    await expect(page.locator('#regBirthDate')).toHaveValue('1990-05-15');
    await page.locator('#regFullName').fill('');
    await page.locator('#regBirthDate').fill('');
    await fixtureOCR(page, {
      fields: {
        fullName: 'Maria Santos Dela Cruz', birthDate: '1995-12-25', address: 'VILLAMONTE BACOLOD CITY',
        idType: 'PHILSYS', idNumber: '1111-2222-3333-4444', expiryDate: null
      }
    });
    await captureProvisionalId(page, true);
    await expect(page.locator('#regFullName')).toHaveValue('Maria Santos Dela Cruz');
    await expect(page.locator('#regBirthDate')).toHaveValue('1995-12-25');
    await page.locator('#confirmIdentityBtn').click();
    await expect(page.locator('#signupSubmitBtn')).toBeDisabled();
  });
  for (const [type, header, number] of [
    ['PHILSYS', 'PHILIPPINE IDENTIFICATION CARD', '1234-5678-9012-3456'],
    ['UMID', 'UNIFIED MULTI-PURPOSE ID', '1111-2222222-3'],
    ['PASSPORT', 'PHILIPPINE PASSPORT', 'P1234567A'],
  ]) {
    test(`real OCR diagnostic preview extracts separate ${type} name fields without activating an account`, async ({ page }) => {
      const lines = ['REPUBLIC OF THE PHILIPPINES', header, `ID NO: ${number}`,
        'SURNAME: SAMPLE', 'GIVEN NAMES: ALEX MORGAN', 'MIDDLE NAME: REYES',
        'DATE OF BIRTH: 15 SEP 2001', 'ADDRESS: VILLAMONTE BACOLOD CITY'];
      if (type === 'PASSPORT') lines.push('DATE OF EXPIRY: 15 SEP 2035');
      const image = await sharp(Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="800"><rect width="1400" height="800" fill="white"/>${lines.map((line, index) => `<text x="45" y="${70 + index * 85}" font-family="Arial" font-size="40" fill="black">${line}</text>`).join('')}</svg>`
      )).png().toBuffer();
      await setUploadTestFlag(page, true);
      await loadPinnedOCR(page);
      await page.reload();
      const writes = [];
      page.on('request', request => {
        if (request.method() === 'POST' && /\/api\/auth\/(enrollment|register)/.test(request.url())) writes.push(request.url());
      });
      await signup(page);
      const picker = page.waitForEvent('filechooser');
      await page.getByRole('button', { name: 'Upload ID File' }).click();
      await (await picker).setFiles({ name: 'synthetic.png', mimeType: 'image/png', buffer: image });
      const results = page.locator('#idUploadTestFields');
      const field = name => results.locator('dt').filter({ hasText: name }).locator('xpath=following-sibling::dd[1]');
      await expect(field(/^Full name$/)).toHaveText('Alex Morgan Reyes Sample', { timeout: 90000 });
      await expect(field(/^Date of birth$/)).toHaveText('09/15/2001');
      await expect(field(/^ID number$/)).toHaveText(number);
      await expect(field(/^Expiration date$/)).toHaveText(type === 'PASSPORT' ? '09/15/2035' : 'Not read');
      await expect(page.locator('#signupSubmitBtn')).toBeDisabled();
      expect(writes).toEqual([]);
    });
  }
  test('document type changes reset expiration and cannot confirm a conflicting scan', async ({ page }) => {
    await signup(page);
    await fixtureOCR(page);
    await captureProvisionalId(page);
    const type = page.locator('#regDocumentType');
    const expiry = page.locator('#regExpiryDate');
    await expect(type).toHaveValue('DRIVERS_LICENSE');
    await expect(expiry).toHaveValue('2030-05-15');
    await type.selectOption('PHILSYS');
    await expect(expiry).toBeHidden();
    await expect(expiry).toHaveValue('');
    await page.locator('#confirmIdentityBtn').click();
    await expect(page.locator('#signupSubmitBtn')).toBeDisabled();
    await type.selectOption('DRIVERS_LICENSE');
    await expect(expiry).toBeVisible();
    await expect(expiry).toHaveJSProperty('required', true);
    await expect(expiry).toHaveValue('');
    await page.locator('#confirmIdentityBtn').click();
    await expect(page.locator('#signupSubmitBtn')).toBeDisabled();
    await expiry.fill('2030-05-15');
    await page.locator('#confirmIdentityBtn').click();
    await expect(page.locator('#signupSubmitBtn')).toBeDisabled();
  });

  for (const [type, camera] of [['PHILSYS', false], ['UMID', false], ['PHILSYS', true]]) {
    test(`${camera ? 'landscape camera capture' : 'portrait phone photo'} reads the physical ${type} card inside its background`, async ({ page }) => {
      const national = type === 'PHILSYS';
      const number = national ? '2222-3333-4444-5555' : '2222-3333333-4';
      const label = (value, x, y, size) =>
        `<text x="${x}" y="${y}" fill="#2c2823" font-family="Arial" font-size="${size}">${value}</text>`;
      const printed = [
        label('REPUBLIC OF THE PHILIPPINES', 280, 490, 25),
        label(national ? 'PAMBANSANG PAGKAKAKILANLAN' : 'Unified Multi-Purpose ID', 280, 532, 25),
        label(national ? number : `CRN: ${number}`, national ? 105 : 555, 632, 24),
        label(national ? 'Apelyido / Last Name' : 'SURNAME', 438, 665, 15),
        label('SAMPLE', 438, 692, 26),
        label(national ? 'Mga Pangalan / Given Names' : 'GIVEN NAME', 438, 718, 15),
        label('TAYLOR', 438, 745, 26),
        label(national ? 'Gitnang Apelyido / Middle Name' : 'MIDDLE NAME', 438, 773, 15),
        label('TEST', 438, 800, 26),
        label(national ? 'Petsa ng Kapanganakan / Date of Birth' : 'DATE OF BIRTH', 438, 827, 15),
        label(national ? 'OCTOBER 18, 1984' : '1984/10/18', 438, 855, 23),
        label(national ? 'Tirahan / Address' : 'ADDRESS', national ? 102 : 438, 883, 16),
        label('LOT 4, SAMPLE STREET, BACOLOD CITY', national ? 102 : 438, 914, 20),
        label('NEGROS OCCIDENTAL', national ? 102 : 438, 944, 20),
      ].join('');
      const texture = Array.from({ length: 52 }, (_, index) =>
        `<path d="M0 ${index * 25} Q400 ${index * 25 - 10} 960 ${index * 25 + 12}" stroke="#625b56" stroke-width="3" fill="none"/>`).join('');
      const picture = sharp(Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="1280">
        <rect width="960" height="1280" fill="#504a47"/>${texture}
        <rect x="42" y="440" width="876" height="558" rx="24" fill="#ded8cb"/>
        <rect x="103" y="653" width="205" height="219" fill="#a6a4a0"/>
        ${printed}
      </svg>`
      ));
      const image = await (camera ? picture.extract({ left: 0, top: 350, width: 960, height: 735 }) : picture).png().toBuffer();

      if (!camera) {
        await setUploadTestFlag(page, true);
        await page.reload();
        await signup(page);
        const picker = page.waitForEvent('filechooser');
        await page.getByRole('button', { name: 'Upload ID File' }).click();
        await (await picker).setFiles({ name: `${type.toLowerCase()}-portrait.png`, mimeType: 'image/png', buffer: image });
        const results = page.locator('#idUploadTestFields');
        const field = name => results.locator('dt').filter({ hasText: name }).locator('xpath=following-sibling::dd[1]');
        await expect(field(/^Full name$/)).toHaveText('Taylor Test Sample', { timeout: 90000 });
        await expect(field(/^Date of birth$/)).toHaveText(national ? '10/18/1984' : '10/18/1984');
        await expect(field(/^Address on government ID$/)).toHaveText(/SAMPLE STREET/i);
        await expect(field(/^ID number$/)).toHaveText(number);
        await expect(page.locator('#signupSubmitBtn')).toBeDisabled();
        return;
      }

      await signup(page);
      await captureProvisionalId(page, false, image);
      await expect(page.locator('#regDocumentType')).toHaveValue(type, { timeout: 90000 });
      await expect(page.locator('#regFullName')).toHaveValue('Taylor Test Sample');
      await expect(page.locator('#regBirthDate')).toHaveValue('1984-10-18');
      await expect(page.locator('#regAddress')).toHaveValue(/SAMPLE STREET/i);
      const normalizeAddress = value => value.toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
      const expectedAddress = 'LOT 4 SAMPLE STREET BACOLOD CITY NEGROS OCCIDENTAL';
      if (national) {
        await expect.poll(async () => normalizeAddress(await page.locator('#regAddress').inputValue())).toBe(expectedAddress);
      }
      await expect(page.locator('#regIdNumber')).toHaveValue(number);
      await expect(page.locator('#regExpiryDate')).toBeHidden();
      await page.locator('#confirmIdentityBtn').click();
      await expect(page.locator('#signupSubmitBtn')).toBeDisabled();
    });
  }

  test("verified live scanner enrollment persists real OCR fields in MySQL", async ({ page, context }, info) => {
    const idNumber = process.env.REGISTRATION_VERIFIED_FIXTURE_NUMBER;
    test.skip(!idNumber, 'Requires the private MySQL fixture with signed issuer and fraud responses.');
    await expect(page.getByText('Demo Credentials', { exact: true })).toHaveCount(0);
    await fixedBrowserLocation(page, context, { latitude: 10.6685, longitude: 122.9647, accuracy: 15 });
    await loadPinnedOCR(page);
    await page.reload();
    await page.evaluate(() => {
      window.autoDetectBarangay = async () => null;
      const verify = window.verifyGovernmentID;
      window.verifyGovernmentID = async file => {
        const result = await verify(file);
        window.syntheticOcrFields = result.fields;
        return result;
      };
    });
    await signup(page);
    await expect(page.locator('#idModeUploadBtn')).toBeHidden();
    const image = await renderLicense(text.replace('FICTIONAL TEST CITIZEN', 'SYNTHETIC TEST CITIZEN')
      .replace('VILLAMONTE BACOLOD CITY', '42 FIXTURE STREET, VILLAMONTE, BACOLOD CITY')
      .replace('N01-23-456789', idNumber).replace('2030-05-15', '2099-01-01'));
    await installAlignedTestCamera(page, image.toString('base64'));
    await page.locator('#idModeCameraBtn').click();
    await page.locator('#idCaptureBtn').click();
    await expect(page.locator('#regIdNumber')).toHaveValue(idNumber);
    await expect(page.locator('#regFullName')).toHaveValue('Synthetic Test Citizen');
    await expect(page.locator('#regBirthDate')).toHaveValue('1990-05-15');
    await expect(page.locator('#regExpiryDate')).toHaveValue('2099-01-01');
    await expect(page.locator('#regAddress')).toHaveValue('42 FIXTURE STREET, Villamonte, BACOLOD CITY');
    await expect.poll(() => page.evaluate(() => window.syntheticOcrFields?.idNumber), { timeout: 60000 }).toBe(idNumber);
    await page.locator('#confirmIdentityBtn').click();
    const username = 'functional_' + info.project.name;
    await credentials(page, username);
    const release = Promise.withResolvers();
    await page.route('**/api/auth/register', async route => {
      await release.promise;
      await route.continue();
    });
    try {
      await page.locator('#signupSubmitBtn').click();
      await expect(page.locator('#signupSubmitBtn')).toBeDisabled();
      await expect(page.locator('#signupSubmitStatus')).toContainText('Waiting for the server');
      await expect(page).toHaveURL(/login\.html$/);
      expect(await page.evaluate(() => sessionStorage.getItem('up_session'))).toBeNull();
    } finally {
      release.resolve();
    }
    await expect(page).toHaveURL(/citizen\.html$/);
    await expect(page.locator('#submitSection')).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('up_users'))).toBeNull();
    expect(await savedIdentity(page)).toMatchObject({
      fullName: 'Synthetic Test Citizen', idNumber, birthDate: '1990-05-15',
      address: '42 FIXTURE STREET, Villamonte, BACOLOD CITY', expiryDate: '2099-01-01',
      documentValidationStatus: 'pass'
    });
    await logout(page, info.project.name);
    await page.locator('#loginUser').fill(username);
    await page.locator('#loginPass').fill('FictionalPass123!');
    await page.locator('#loginForm button[type="submit"]').click();
    await expect(page).toHaveURL(/citizen\.html$/);
    await logout(page, info.project.name);
  });

  test("upload test transitions to live LTO verification, auto-fill, and registration", async ({
    page,
    context,
  }, info) => {
    test.skip(process.env.NEIGHBORLENS_ENROLLMENT_FIXTURE !== '1', 'Requires isolated signed verifier.');
    await fixedBrowserLocation(page, context, { latitude: 10.66850, longitude: 122.96470, accuracy: 15 });
    const mobile = info.project.name === 'mobile';
    const idNumber = mobile ? 'N23-45-678924' : 'N23-45-678923';
    const label = (text, x, y, size = 14) =>
      `<text x="${x}" y="${y}" font-family="Arial" font-size="${size}" fill="black">${text}</text>`;
    const image = await sharp(
      Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500"><rect width="800" height="500" fill="#eee9cf"/><rect x="25" y="105" width="170" height="230" fill="#c7c7c7"/>${[
          label("REPUBLIC OF THE PHILIPPINES", 230, 40, 18),
          label("LAND TRANSPORTATION OFFICE", 230, 68, 18),
          label("DRIVERS LICENSE", 230, 94, 18),
          label("Last Name, First Name, Middle Name", 230, 125, 10),
          label("SAMPLE, ALEX MORGAN", 230, 146, 16),
          label("Nationality", 230, 176, 10),
          label("Sex", 310, 176, 10),
          label("Date of Birth", 360, 176, 10),
          label("Weight", 490, 176, 10),
          label("Height", 560, 176, 10),
          label("PHL", 230, 196),
          label("M", 310, 196),
          label("1992/04/23", 360, 196),
          label("70", 490, 196),
          label("1.75", 560, 196),
          label("Address", 230, 230, 10),
          label("42 FICTIONAL STREET, VILLAMONTE", 230, 250),
          label("BACOLOD CITY", 230, 270),
          label("License No.", 230, 310, 10),
          label("Expiration Date", 425, 310, 10),
          label("Agency Code", 600, 310, 10),
          label(idNumber, 230, 332, 16),
          label("2032/04/23", 425, 332, 16),
          label("N23", 600, 332, 16),
          label("FICTIONAL TEST DOCUMENT", 230, 420, 12),
        ].join("")}</svg>`,
      ),
    )
      .png()
      .toBuffer();
    await setUploadTestFlag(page, true);
    await page.goto('/login.html');
    await page.evaluate(() => { window.autoDetectBarangay = async () => null; });
    await signup(page);
    const enrollmentRequests = [];
    page.on('request', request => {
      const path = new URL(request.url()).pathname;
      if (/\/api\/auth\/(enrollment|register)/.test(path)) enrollmentRequests.push(path);
    });
    const picker = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Upload ID File' }).click();
    await (await picker).setFiles({ name: 'synthetic-lto.png', mimeType: 'image/png', buffer: image });
    await expect(page.locator('#idVerifyStatus')).toContainText('Upload test complete', { timeout: 30000 });
    await expect(page.locator('#signupSubmitBtn')).toBeDisabled();
    expect(enrollmentRequests).toEqual([]);

    await installAlignedTestCamera(page, image.toString('base64'), mobile ? '#305f55' : '#305f32');
    await page.locator('#idModeCameraBtn').click();
    await expect(page.locator('#idUploadTestResult')).toBeHidden();
    await page.locator('#idCaptureBtn').click();
    await expect(page.locator('#idVerifyStatus strong')).toHaveText("Valid Driver's License");
    await expect(page.locator("#regFullName")).toHaveValue("Alex Morgan Sample", {
      timeout: 90000,
    });
    await expect(page.locator("#regBirthDate")).toHaveValue("1992-04-23");
    await expect(page.locator("#regAddress")).toHaveValue(
      /42 FICTIONAL STREET.*VILLAMONTE.*BACOLOD CITY/,
    );
    await expect(page.locator("#regIdNumber")).toHaveValue(idNumber);
    await expect(page.locator("#regExpiryDate")).toHaveValue("2032-04-23");
    await page
      .locator("#identityFields")
      .screenshot({
        path: `.data/registration-functional/${info.project.name}-scanned-fields.png`,
      });
    await page.locator("#confirmIdentityBtn").click();
    await credentials(page, "compact_" + Date.now());
    const [registerResponse] = await Promise.all([
      page.waitForResponse((res) => res.request().method() === "POST" && new URL(res.url()).pathname === "/api/auth/register"),
      page.locator("#signupSubmitBtn").click(),
    ]);
    expect(registerResponse.status()).toBe(201);
    await expect(page).toHaveURL(/citizen.html$/);
    expect(enrollmentRequests).toEqual([
      '/api/auth/enrollment/options', '/api/auth/enrollment/start', '/api/auth/enrollment/capture', '/api/auth/register'
    ]);
    expect(await savedIdentity(page)).toMatchObject({
      fullName: "Alex Morgan Sample",
      birthDate: "1992-04-23",
      idNumber,
      expiryDate: "2032-04-23",
      documentValidationStatus: "pass",
    });
    await page.screenshot({
      path: `.data/registration-functional/${info.project.name}-compact-registered.png`,
      fullPage: true,
    });
  });

  test("synthetic LTO driver's license with valid birthdate extracts full name, birthdate, clean address and ID number", async ({
    page,
  }, info) => {
    const label = (text, x, y, size = 14) =>
      `<text x="${x}" y="${y}" font-family="Arial" font-size="${size}" fill="black">${text}</text>`;
    const image = await sharp(
      Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600"><rect width="900" height="600" fill="#e8e2c8"/><rect x="25" y="120" width="180" height="230" fill="#bbb"/>${[
          label("REPUBLIC OF THE PHILIPPINES", 240, 50, 16),
          label("LAND TRANSPORTATION OFFICE", 240, 75, 16),
          label("DRIVERS LICENSE", 240, 102, 16),
          label("Last Name, First Name, Middle Name", 240, 135, 10),
          label("DELA CRUZ, JOSIE", 240, 155, 15),
          label("Nationality", 240, 185, 10),
          label("Sex", 340, 185, 10),
          label("Date of Birth", 400, 185, 10),
          label("Weight", 520, 185, 10),
          label("Height", 600, 185, 10),
          label("PHL", 240, 205, 13),
          label("F", 340, 205, 13),
          label("1999/07/11", 400, 205, 13),
          label("52", 520, 205, 13),
          label("1.62", 600, 205, 13),
          label("Address", 240, 240, 10),
          label("#012 A-345, SAMPLE STREET, MANILA", 240, 260, 13),
          label("License No.", 240, 300, 10),
          label("Expiration Date", 450, 300, 10),
          label("Agency Code", 650, 300, 10),
          label("A01-23-456789", 240, 322, 15),
          label("2030/07/11", 450, 322, 15),
          label("N01", 650, 322, 15),
          label("FICTIONAL TEST DOCUMENT", 240, 420, 12),
        ].join("")}</svg>`,
      ),
    )
      .png()
      .toBuffer();

    await signup(page);
    await captureProvisionalId(page, false, image);
    await expect(page.locator("#regFullName")).toHaveValue("Josie Dela Cruz", {
      timeout: 90000,
    });
    await expect(page.locator("#regBirthDate")).toHaveValue("1999-07-11");
    await expect(page.locator("#regAddress")).toHaveValue(
      "#012 A-345, SAMPLE STREET, MANILA",
    );
    await expect(page.locator("#regIdNumber")).toHaveValue("A01-23-456789");
    await expect(page.locator("#regExpiryDate")).toHaveValue("2030-07-11");
    expect(await page.locator("#regFullName").inputValue()).not.toBe("..");
    expect(await page.locator("#regAddress").inputValue()).not.toMatch(/^NN[,:\-\s]/);

    await page.locator("#confirmIdentityBtn").click();
    await expect(page.locator("#signupSubmitBtn")).toBeDisabled();
    await expect(page.locator("#signupMsg")).toContainText("Identity verification is required before registration");
  });
  test("real-format LTO driver's license extracts full name, birthdate, provincial camp address and ID number", async ({
    page,
  }, info) => {
    const label = (text, x, y, size = 14) =>
      `<text x="${x}" y="${y}" font-family="Arial" font-size="${size}" fill="black">${text}</text>`;
    const image = await sharp(
      Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600"><rect width="900" height="600" fill="#e8e2c8"/><rect x="25" y="120" width="180" height="230" fill="#bbb"/>${[
          label("LAND TRANSPORTATION OFFICE", 240, 75, 16),
          label("NON-PROFESSIONAL DRIVER'S LICENSE", 240, 102, 16),
          label("Last Name, First Name, Middle Name", 240, 135, 10),
          label("CLEMENTIR, KENT ASHLEY TUAZON", 240, 155, 15),
          label("Nationality", 240, 185, 10),
          label("Sex", 340, 185, 10),
          label("Date of Birth", 400, 185, 10),
          label("Weight", 520, 185, 10),
          label("Height", 600, 185, 10),
          label("PHL", 240, 205, 13),
          label("M", 340, 205, 13),
          label("1999/07/11", 400, 205, 13),
          label("56", 520, 205, 13),
          label("1.65", 600, 205, 13),
          label("Address", 240, 240, 10),
          label("P-3, BASE CAMP, MARAMAG, BUKIDNON, 8714", 240, 260, 13),
          label("License No.", 240, 300, 10),
          label("Expiration Date", 450, 300, 10),
          label("Agency Code", 650, 300, 10),
          label("K22-22-000371", 240, 322, 15),
          label("2027/07/11", 450, 322, 15),
          label("K22", 650, 322, 15),
        ].join("")}</svg>`,
      ),
    )
      .png()
      .toBuffer();

    await signup(page);
    await captureProvisionalId(page, false, image);
    await expect(page.locator("#regFullName")).toHaveValue("Kent Ashley Tuazon Clementir", {
      timeout: 90000,
    });
    await expect(page.locator("#regBirthDate")).toHaveValue("1999-07-11");
    await expect(page.locator("#regAddress")).toHaveValue(
      "P-3, BASE CAMP, MARAMAG, BUKIDNON, 8714",
    );
    await expect(page.locator("#regIdNumber")).toHaveValue("K22-22-000371");
    await expect(page.locator("#regExpiryDate")).toHaveValue("2027-07-11");

    await page.locator("#confirmIdentityBtn").click();
    await expect(page.locator("#signupSubmitBtn")).toBeDisabled();
  });

  test("real-format LTO driver's license keeps the printed 900 serial", async ({
    page,
  }) => {
    await signup(page);
    await fixtureOCR(page, {
      rawText: `LAND TRANSPORTATION OFFICE DRIVERS LICENSE
Last Name. First Name Middle
CLEMENTIR, KENT ASHLEY TUAZON
Nationality Sex Date of Birth Weight Height
PHL M 1999/07/11 56 1.65
Address
P-3, BASE CAMP, MARAMAG, BUKIDNON, 8714
License No. Expiration Date Agency Code
K22-22-900371 2027/07/11 K22`,
    });
    await captureProvisionalId(page);
    await expect(page.locator("#regFullName")).toHaveValue("Kent Ashley Tuazon Clementir");
    await expect(page.locator("#regBirthDate")).toHaveValue("1999-07-11");
    await expect(page.locator("#regAddress")).toHaveValue("P-3, BASE CAMP, MARAMAG, BUKIDNON, 8714");
    await expect(page.locator("#regIdNumber")).toHaveValue("K22-22-900371");
    await expect(page.locator("#regExpiryDate")).toHaveValue("2027-07-11");
  });

  test("synthetic LTO driver's license with placeholder YYYY/MM/DD does not fabricate birthdate and permits manual completion", async ({
    page,
  }, info) => {
    const label = (text, x, y, size = 14) =>
      `<text x="${x}" y="${y}" font-family="Arial" font-size="${size}" fill="black">${text}</text>`;
    const image = await sharp(
      Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600"><rect width="900" height="600" fill="#e8e2c8"/><rect x="25" y="120" width="180" height="230" fill="#bbb"/>${[
          label("REPUBLIC OF THE PHILIPPINES", 240, 50, 16),
          label("LAND TRANSPORTATION OFFICE", 240, 75, 16),
          label("DRIVERS LICENSE", 240, 102, 16),
          label("Last Name, First Name, Middle Name", 240, 135, 10),
          label("DELA CRUZ, JOSIE", 240, 155, 15),
          label("Nationality", 240, 185, 10),
          label("Sex", 340, 185, 10),
          label("Date of Birth", 400, 185, 10),
          label("Weight", 520, 185, 10),
          label("Height", 600, 185, 10),
          label("PHL", 240, 205, 13),
          label("F", 340, 205, 13),
          label("YYYY/MM/DD", 400, 205, 13),
          label("52", 520, 205, 13),
          label("1.62", 600, 205, 13),
          label("Address", 240, 240, 10),
          label("#012 A-345, SAMPLE STREET, MANILA", 240, 260, 13),
          label("License No.", 240, 300, 10),
          label("Expiration Date", 450, 300, 10),
          label("Agency Code", 650, 300, 10),
          label("A01-23-456789", 240, 322, 15),
          label("2030/07/11", 450, 322, 15),
          label("N01", 650, 322, 15),
          label("FICTIONAL TEST DOCUMENT", 240, 420, 12),
        ].join("")}</svg>`,
      ),
    )
      .png()
      .toBuffer();

    await signup(page);
    await captureProvisionalId(page, false, image);
    await expect(page.locator("#regFullName")).toHaveValue("Josie Dela Cruz", {
      timeout: 90000,
    });
    await expect(page.locator("#regBirthDate")).toHaveValue("");
    await expect(page.locator("#regAddress")).toHaveValue(
      "#012 A-345, SAMPLE STREET, MANILA",
    );
    await expect(page.locator("#regIdNumber")).toHaveValue("A01-23-456789");
    expect(await page.locator("#regFullName").inputValue()).not.toBe("..");
    expect(await page.locator("#regAddress").inputValue()).not.toMatch(/^NN[,:\-\s]/);
    expect(await page.locator("#regBirthDate").inputValue()).not.toBe("YYYY/MM/DD");

    await page.locator("#confirmIdentityBtn").click();
    await expect(page.locator("#identityReviewStatus")).toContainText(
      "required identity fields",
    );
    await expect(page.locator("#signupSubmitBtn")).toBeDisabled();

    await page.locator("#regBirthDate").fill("1999-07-11");
    await page.locator("#confirmIdentityBtn").click();
    await expect(page.locator("#signupMsg")).toContainText("Identity verification is required before registration");
    await expect(page.locator("#signupSubmitBtn")).toBeDisabled();
  });

  test("uploading a replacement ID resets previous document dates and change event updates review state", async ({ page }) => {
    await signup(page);
    await fixtureOCR(page, {
      fields: {
        fullName: "Initial First Cardholder",
        birthDate: "07/11/1999",
        address: "INITIAL ADDRESS",
        idType: "DRIVERS_LICENSE",
        idNumber: "K22-22-000371",
        expiryDate: "07/11/2027",
      },
    });
    await captureProvisionalId(page);
    await expect(page.locator("#regFullName")).toHaveValue("Initial First Cardholder");
    await expect(page.locator("#regBirthDate")).toHaveValue("1999-07-11");
    await expect(page.locator("#regExpiryDate")).toHaveValue("2027-07-11");

    await fixtureOCR(page, {
      fields: {
        fullName: "Josie Dela Cruz",
        birthDate: "",
        address: "#012 A-345, SAMPLE STREET, MANILA",
        idType: "DRIVERS_LICENSE",
        idNumber: "A01-23-456789",
        expiryDate: "",
      },
    });
    await captureProvisionalId(page, true);
    await expect(page.locator("#regFullName")).toHaveValue("Josie Dela Cruz");
    await expect(page.locator("#regBirthDate")).toHaveValue("");
    await expect(page.locator("#regExpiryDate")).toHaveValue("");
    await expect(page.locator("#regIdNumber")).toHaveValue("A01-23-456789");
    await expect(page.locator("#identityReviewStatus")).toContainText("Date of birth");

    await page.evaluate(() => {
      const el = document.getElementById("regBirthDate");
      el.value = "1998-04-20";
      el.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await expect(page.locator("#identityReviewStatus")).toContainText("Expiration date");
    await page.locator("#confirmIdentityBtn").click();
    await expect(page.locator("#signupSubmitBtn")).toBeDisabled();
    await page.locator("#regExpiryDate").fill("2030-05-15");
    await expect(page.locator("#identityReviewStatus")).toContainText("Review or correct the scanned fields");

    await page.locator("#confirmIdentityBtn").click();
    await expect(page.locator("#identityReviewStatus")).toContainText("OCR details confirmed");
    await expect(page.locator("#signupSubmitBtn")).toBeDisabled();
  });

  for (const pending of [false, true]) test(`synthetic PhilSys card with bilingual labels ${pending
    ? 'keeps registration and prefill gated without independent approval'
    : 'extracts full name, birthdate, and clean address'}`, async ({
      page,
      context,
    }, info) => {
    test.skip(process.env.NEIGHBORLENS_ENROLLMENT_FIXTURE !== '1', 'Run with the isolated enrollment verifier fixture.');
    const mobile = info.project.name === 'mobile';
    const idNumber = mobile ? '1234-5678-9012-3457' : '1234-5678-9012-3456';
    const address = pending ? 'PUROK 3 SAMPLE STREET MANILA' : 'LOT 5 BLOCK 2, SAMPLE STREET, VILLAMONTE, BACOLOD CITY';
    if (!pending) {
      await fixedBrowserLocation(page, context, { latitude: 10.66850, longitude: 122.96470, accuracy: 15 });
    }
    const label = (text, x, y, size = 14) =>
      `<text x="${x}" y="${y}" font-family="Arial" font-size="${size}" fill="black">${text}</text>`;
    const image = await sharp(
      Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="1800" height="1200" viewBox="0 0 900 600"><rect width="900" height="600" fill="#f4ede1"/><rect x="25" y="120" width="180" height="230" fill="#bbb"/>${[
          label("REPUBLIC OF THE PHILIPPINES", 250, 55, 24),
          label("PHILIPPINE IDENTIFICATION CARD", 250, 100, 26),
          label(idNumber, 62, 198, 23),
          label("Apelyido / Last Name", 394, 201, 16),
          label("DELA CRUZ", 394, 231, 25),
          label("Mga Pangalan / Given Names", 394, 260, 16),
          label("JOSIE SANTOS", 394, 288, 25),
          label("Gitnang Apelyido / Middle Name", 394, 326, 16),
          label("REYES", 394, 355, 25),
          label("Date of Birth", 394, 389, 16),
          label("JULY 11, 1999", 394, 419, 24),
          label("Tirahan / Address", 85, 464, 19),
          label(address, 85, 516, 26),
          label("SYNTHETIC TEST", 52, 52, 13),
        ].join("")}</svg>`,
      ),
    )
      .png()
      .toBuffer();

    await signup(page);
    await expect(page.locator('#signupCredentials')).toBeHidden();
    await installAlignedTestCamera(page, image.toString('base64'), pending ? '#683535' : mobile ? '#34305e' : '#32302e');
    await page.locator('#idModeCameraBtn').click();
    await expect(page.locator('#idCaptureBtn')).toBeVisible();
    await expect(page.locator('#idCaptureBtn')).toBeEnabled();
    await page.locator('#idCaptureBtn').click();
    if (pending) {
      await expect(page.locator('#idVerifyStatus')).toHaveAttribute('data-scan-code', 'VERIFICATION_REQUIRED', { timeout: 30000 });
      await expect(page.locator('#regFullName')).toBeEditable();
      await expect(page.locator('#signupSubmitBtn')).toBeDisabled();
      return;
    }
    await expect(page.locator("#regFullName")).toHaveValue("Josie Santos Reyes Dela Cruz", {
      timeout: 15000,
    });
    await expect(page.locator("#regBirthDate")).toHaveValue("1999-07-11");
    await expect(page.locator("#regAddress")).toHaveValue(address);
    await expect(page.locator("#regIdNumber")).toHaveValue(idNumber);
    await expect(page.locator('#idVerifyStatus strong')).toHaveText('Valid National ID');
    await expect(page.locator('#signupCredentials')).toBeHidden();
    expect(await page.locator("#regAddress").inputValue()).not.toMatch(/^[/\s,]+/);

    await page.locator("#confirmIdentityBtn").click();
    await expect(page.locator('#signupCredentials')).toBeVisible();
    await expect(page.locator("#regExpiryDate")).toBeHidden();
    await expect(page.getByText("No expiration date required.")).toBeVisible();
    const username = "philsys_bilingual_" + Date.now();
    await credentials(page, username);
    const [registerResponse] = await Promise.all([
      page.waitForResponse((res) => res.request().method() === "POST" && new URL(res.url()).pathname === "/api/auth/register"),
      page.locator("#signupSubmitBtn").click(),
    ]);
    expect(registerResponse.status()).toBe(201);
    await expect(page).toHaveURL(/citizen.html$/);
    expect(await savedIdentity(page)).toMatchObject({
      fullName: "Josie Santos Reyes Dela Cruz",
      birthDate: "1999-07-11",
      address,
      idNumber,
      documentValidationStatus: "pass",
      expiryDate: null,
      expirationStatus: "NOT_APPLICABLE",
      isExpired: null,
    });
  });

  test("synthetic Passport biodata page with bilingual labels extracts name and birthdate without fabricating address", async ({
    page,
  }, info) => {
    const label = (text, x, y, size = 14) =>
      `<text x="${x}" y="${y}" font-family="Arial" font-size="${size}" fill="black">${text}</text>`;
    const image = await sharp(
      Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600"><rect width="900" height="600" fill="#e9eef4"/><rect x="25" y="120" width="180" height="230" fill="#bbb"/>${[
          label("REPUBLIC OF THE PHILIPPINES", 240, 50, 16),
          label("PASSPORT / PASAPORTE", 240, 75, 16),
          label("PASSPORT NO. / PASAPORTE BLG.", 240, 115, 10),
          label("P1234567A", 240, 135, 15),
          label("SURNAME / APELYIDO", 240, 165, 10),
          label("DELA CRUZ", 240, 185, 15),
          label("GIVEN NAMES / MGA PANGALAN", 240, 215, 10),
          label("JOSIE", 240, 235, 15),
          label("DATE OF BIRTH / PETSA NG KAPANGANAKAN", 240, 265, 10),
          label("11 JUL 1999", 240, 285, 15),
          label("DATE OF EXPIRY / PETSA NG PAGKAPASO", 240, 315, 10),
          label("11 JUL 2030", 240, 335, 15),
        ].join("")}</svg>`,
      ),
    )
      .png()
      .toBuffer();

    await setUploadTestFlag(page, true);
    await page.reload();
    await signup(page);
    const picker = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: "Upload ID File" }).click();
    await (await picker).setFiles({ name: "passport.png", mimeType: "image/png", buffer: image });
    const results = page.locator("#idUploadTestFields");
    const field = name => results.locator("dt").filter({ hasText: name }).locator("xpath=following-sibling::dd[1]");
    await expect(field(/^Full name$/)).toHaveText("Josie Dela Cruz", { timeout: 90000 });
    await expect(field(/^Date of birth$/)).toHaveText("07/11/1999");
    await expect(field(/^Address on government ID$/)).toHaveText("Not read");
    await expect(field(/^ID number$/)).toHaveText("P1234567A");
    await expect(page.locator("#signupSubmitBtn")).toBeDisabled();
  });

  test("dense license fields remain readable at the dimensions of the reported card", async ({
    page,
    request,
  }, info) => {
    const text = (value, x, y, size = 11) =>
      `<text x="${x}" y="${y}" font-family="Arial" font-size="${size}" fill="#242424">${value}</text>`;
    const image = await sharp(
      Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="850" height="530"><rect width="850" height="530" fill="#dfd6b2"/><rect x="28" y="145" width="180" height="230" fill="#abab9e"/><path d="M0 400L850 120M0 410L850 130M0 420L850 140" stroke="#b2bdd0" stroke-width="1" opacity=".25"/>${[
          text("REPUBLIC OF THE PHILIPPINES", 250, 55, 15),
          text("LAND TRANSPORTATION OFFICE", 250, 78, 14),
          text("DRIVERS LICENSE", 250, 102, 15),
          text("Last Name, First Name, Middle Name", 250, 160, 8),
          text("SAMPLE, ALEX MORGAN", 250, 179, 12),
          text("Nationality", 250, 209, 8),
          text("Sex", 400, 209, 8),
          text("Date of Birth", 470, 209, 8),
          text("Weight", 600, 209, 8),
          text("Height", 680, 209, 8),
          text("PHL", 250, 227),
          text("M", 400, 227),
          text("1992/04/23", 470, 227, 15),
          text("70", 600, 227),
          text("1.75", 680, 227),
          text("Address", 250, 251, 8),
          text("P-7 HILLSIDE ROAD", 250, 266),
          text("EXAMPLE TOWN, SAMPLE PROVINCE, 1234", 250, 281),
          text("License No.", 250, 319, 8),
          text("Expiration Date", 470, 319, 8),
          text("Agency Code", 650, 319, 8),
          text("N23-45-678923", 250, 336),
          text("2032/04/23", 470, 336, 15),
          text("N23", 650, 336),
          text("Blood Type", 250, 368, 8),
          text("Restrictions", 400, 368, 8),
          text("Conditions", 550, 368, 8),
          text("O+", 250, 385),
          text("1", 400, 385),
          text("NONE", 550, 385),
          text("FICTIONAL TEST DOCUMENT", 250, 450, 12),
        ].join("")}</svg>`,
      ),
    )
      .png()
      .toBuffer();
    const seeded = await request.post("/__fixture_citizen", {
      data: { username: "dense_ocr_" + Date.now(), password: "FictionalPass123!", barangay: "Villamonte", reporting: false },
    });
    expect(seeded.status()).toBe(201);
    const { token, user } = await seeded.json();
    await page.evaluate(({ token, user }) => {
      sessionStorage.setItem("up_session", JSON.stringify({
        id: user.id, username: user.username, role: user.role,
        barangay: user.barangay, fullName: user.full_name || "", apiToken: token,
      }));
    }, { token, user });
    await page.goto('/login.html?complete-identity=1');
    await page.evaluate(() => { window.autoDetectBarangay = async () => null; });
    await page.locator("#recoverIdentityBtn").click();
    await page.evaluate(() => {
      const read = window.verifyGovernmentID;
      window.verifyGovernmentID = async (file) => {
        const result = await read(file);
        window.fictionalDenseReading = {
          rawText: result.rawText,
          words: result.words,
          fields: result.fields,
        };
        return result;
      };
    });
    await upload(page, image);
    await expect(page.locator("#verifyIdBtn")).toBeEnabled({ timeout: 90000 });
    await fs.mkdir(".data/registration-functional", { recursive: true });
    await fs.writeFile(
      `.data/registration-functional/${info.project.name}-dense-fictional-ocr.json`,
      JSON.stringify(await page.evaluate(() => window.fictionalDenseReading)),
    );
    await expect(page.locator("#regFullName")).toHaveValue("Alex Morgan Sample");
    await expect(page.locator("#regBirthDate")).toHaveValue("1992-04-23");
    await expect(page.locator("#regAddress")).toHaveValue(
      "P-7 HILLSIDE ROAD, EXAMPLE TOWN, SAMPLE PROVINCE, 1234",
    );
    await expect(page.locator("#regIdNumber")).toHaveValue("N23-45-678923");
    await expect(page.locator("#regExpiryDate")).toHaveValue("2032-04-23");
    await page
      .locator("#identityFields")
      .screenshot({
        path: `.data/registration-functional/${info.project.name}-dense-scanned-fields.png`,
      });
    await page.evaluate(async () => {
      const worker = await ensureTesseract();
      const recognize = worker.recognize.bind(worker);
      window.focusedReadCalls = 0;
      worker.recognize = async (...args) => {
        const result = await recognize(...args);
        window.focusedReadCalls++;
        if (window.focusedReadCalls <= 2) {
          result.data.words = result.data.words.filter(word => !/1992|2032/.test(word.text) && !(word.bbox.y0 >= 420 && word.bbox.y0 < 470));
          result.data.text = result.data.words.map(word => word.text).join(' ');
        }
        return result;
      };
    });
    await page.locator("#verifyIdBtn").click();
    await expect(page.locator("#verifyIdBtn")).toBeEnabled({ timeout: 90000 });
    await expect(page.locator("#regBirthDate")).toHaveValue("1992-04-23");
    await expect(page.locator("#regAddress")).toHaveValue("P-7 HILLSIDE ROAD, EXAMPLE TOWN, SAMPLE PROVINCE, 1234");
    await expect(page.locator("#regExpiryDate")).toHaveValue("2032-04-23");
    expect(await page.evaluate(() => window.focusedReadCalls)).toBe(5);
  });

  test("missing scan fields explain registration blocking and manual review can recover", async ({
    page,
  }) => {
    await signup(page);
    await fixtureOCR(page, {
      rawText:
        "DRIVERS LICENSE\nFULL NAME: MIDDLE NOME\nLICENSE NO: N01-23-456789",
      confidence: 62,
    });
    await captureProvisionalId(page);
    await expect(page.locator("#identityReviewStatus")).toContainText(
      "Full name, Date of birth, Address on government ID",
    );
    await page.locator("#confirmIdentityBtn").click();
    await expect(page.locator("#identityReviewStatus")).toContainText(
      "required identity fields",
    );
    await expect(page.locator("#signupSubmitBtn")).toBeDisabled();
    await page.locator("#regFullName").fill("Fictional Test Citizen");
    await page.locator("#regBirthDate").fill("1990-05-15");
    await page.locator("#regAddress").fill("VILLAMONTE BACOLOD CITY");
    await page.locator("#regExpiryDate").fill("2030-05-15");
    await page.locator("#confirmIdentityBtn").click();
    await expect(page.locator("#signupMsg")).toContainText("Identity verification is required before registration");
    await expect(page.locator("#signupSubmitBtn")).toBeDisabled();
  });
  test("partial failure retries identity only and refresh recovery reuses the authenticated account", async ({
    page,
    request,
  }) => {
    let registrations = 0;
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        new URL(request.url()).pathname === "/api/auth/register"
      )
        registrations++;
    });
    const username = "recovery_" + Date.now();
    const seeded = await request.post("/__fixture_citizen", {
      data: { username, password: "FictionalPass123!", barangay: "Villamonte", reporting: false },
    });
    expect(seeded.status()).toBe(201);
    const { token, user } = await seeded.json();
    await page.evaluate(({ token, user }) => {
      sessionStorage.setItem("up_session", JSON.stringify({
        id: user.id, username: user.username, role: user.role,
        barangay: user.barangay, fullName: user.full_name || "", apiToken: token,
      }));
    }, { token, user });
    await page.goto('/login.html?complete-identity=1');
    await page.evaluate(() => {
      window.autoDetectBarangay = async () => null;
    });
    await page.locator("#recoverIdentityBtn").click();
    await expect(page.locator("#signupMsg")).toContainText("Account already exists");
    await fixtureOCR(page);
    await upload(page);
    await confirm(page);
    await page.route("**/api/identity", (route) =>
      route.fulfill({ status: 503, json: { error: "Controlled failure" } }),
    );
    await page.locator("#signupSubmitBtn").click();
    await expect(page.locator("#signupMsg")).toContainText(
      "Account created; identity was not saved",
    );
    await page.reload();
    expect(await page.evaluate(() => sessionStorage.getItem("up_session"))).not.toBeNull();
    await page.goto('/login.html?complete-identity=1');
    await page.evaluate(() => {
      window.autoDetectBarangay = async () => null;
    });
    await page.locator("#recoverIdentityBtn").click();
    await expect(page.locator("#signupMsg")).toContainText(
      "Account already exists",
    );
    await fixtureOCR(page);
    await upload(page);
    await confirm(page);
    await page.unroute("**/api/identity");
    await page.locator("#signupSubmitBtn").click();
    await expect(page).toHaveURL(/citizen.html$/);
    expect((await savedIdentity(page)).documentValidationStatus).toBe("needs_review");
    const recoveredSession = await page.evaluate(() => JSON.parse(sessionStorage.getItem("up_session")));
    expect(recoveredSession.residencyVerified).not.toBe(true);
    expect(registrations).toBe(0);
  });

  test("registration explains the missing ID gate and displays native credential validation", async ({ page }) => {
    let submissions = 0;
    page.on("request", (request) => {
      if (request.method() === "POST" && new URL(request.url()).pathname === "/api/auth/register") submissions++;
    });
    await signup(page);
    await page.locator("#signupSubmitBtn").scrollIntoViewIfNeeded();
    await expect(page.locator("#signupSubmitStatus")).toBeVisible();
    await expect(page.locator("#signupSubmitStatus")).toContainText("Government ID scan required");
    await expect(page.locator("#signupSubmitBtn")).toBeDisabled();
    expect(submissions).toBe(0);
    await captureApprovedId(page);
    await expect(page.locator("#signupSubmitStatus")).toContainText("reviewed and confirmed");
    await page.locator('#confirmIdentityBtn').click();
    await credentials(page, "gate_" + Date.now());
    await page.locator("#regUser").fill("");
    await page.locator("#signupSubmitBtn").click();
    await expect(page.locator("#signupMsg")).toContainText("Username:");
    await expect(page.locator("#signupMsg")).toHaveAttribute("role", "alert");
    await expect(page).toHaveURL(/login.html/);
    expect(submissions).toBe(0);
  });

  test("registration waits for the atomic account response before opening the portal", async ({ page }) => {
    await signup(page);
    await captureApprovedId(page);
    await page.locator('#confirmIdentityBtn').click();
    const username = 'redirect_' + Date.now();
    await credentials(page, username);
    const citizen = { id: 12, role: 'citizen', username, barangay: 'Villamonte', residencyVerified: true };
    const token = 'synthetic-portal-session';
    const release = Promise.withResolvers();
    await page.route('**/api/**', route => {
      const url = new URL(route.request().url());
      if (url.pathname !== '/api/me') return route.fulfill({ json: [] });
      expect(route.request().headers().authorization).toBe(`Bearer ${token}`);
      return route.fulfill({ json: { user: citizen } });
    });
    await page.route('**/api/auth/register', async route => {
      expect(route.request().postDataJSON()).toMatchObject({
        username, identity: { idNumber: 'N01-23-456789' }
      });
      await release.promise;
      await route.fulfill({ status: 201, json: { token, user: citizen, identity: { documentValidationStatus: 'pass' } } });
    });
    try {
      await page.locator("#signupSubmitBtn").click();
      await expect(page.locator("#signupSubmitBtn")).toHaveText("Submitting...");
      await expect(page.locator("#signupSubmitBtn")).toBeDisabled();
      await expect(page.locator("#signupSubmitStatus")).toContainText("Waiting for the server");
      await expect(page.locator("#signupMsg")).toContainText("Waiting for server confirmation");
      expect(await page.evaluate(() => sessionStorage.getItem('up_session'))).toBeNull();
      await expect(page).toHaveURL(/login.html/);
    } finally {
      release.resolve();
    }
    await expect(page).toHaveURL(/citizen.html$/);
    await expect(page.locator('#submitSection')).toBeVisible();
  });

  test("registration network failure stays visible without redirect or automatic account retry", async ({ page }) => {
    await signup(page);
    await captureApprovedId(page);
    await page.locator('#confirmIdentityBtn').click();
    await credentials(page, "network_" + Date.now());
    let attempts = 0;
    await page.route("**/api/auth/register", (route) => {
      attempts++;
      return route.abort();
    });
    await page.locator("#signupSubmitBtn").click();
    await expect(page.locator("#signupMsg")).toContainText("Cannot reach the server");
    await expect(page.locator("#signupMsg")).toBeVisible();
    await expect(page).toHaveURL(/login.html/);
    expect(await page.evaluate(() => sessionStorage.getItem("up_session"))).toBeNull();
    await page.locator("#signupSubmitBtn").click();
    await expect(page.locator("#signupMsg")).toContainText("Log in to recover");
    expect(attempts).toBe(1);
  });

  test("failed server document validation prevents redirect and corrections reuse the created account", async ({ page, request }) => {
    let registrations = 0;
    page.on("request", (request) => {
      if (request.method() === "POST" && new URL(request.url()).pathname === "/api/auth/register") registrations++;
    });
    const username = "document_failure_" + Date.now();
    const seeded = await request.post("/__fixture_citizen", {
      data: { username, password: "FictionalPass123!", barangay: "Villamonte", reporting: false },
    });
    expect(seeded.status()).toBe(201);
    const { token, user } = await seeded.json();
    await page.evaluate(({ token, user }) => {
      sessionStorage.setItem("up_session", JSON.stringify({
        id: user.id, username: user.username, role: user.role,
        barangay: user.barangay, fullName: user.full_name || "", apiToken: token,
      }));
    }, { token, user });
    await page.goto('/login.html?complete-identity=1');
    await page.evaluate(() => { window.autoDetectBarangay = async () => null; });
    await page.locator("#recoverIdentityBtn").click();
    await fixtureOCR(page);
    await upload(page);
    await confirm(page);
    await page.route("**/api/identity", (route) => route.continue({
      postData: JSON.stringify({ ...route.request().postDataJSON(), expiryDate: "2000-01-01" }),
    }));
    await page.locator("#signupSubmitBtn").click();
    await expect(page.locator("#signupMsg")).toContainText("failed document validation");
    await expect(page).toHaveURL(/login.html/);
    expect(await savedIdentity(page)).toMatchObject({
      documentValidationStatus: "fail",
      isExpired: true,
    });
    await expect(page.locator("#signupSubmitBtn")).toHaveText("Save identity corrections");
    await page.unroute("**/api/identity");
    await page.locator("#signupSubmitBtn").click();
    await expect(page).toHaveURL(/citizen.html$/);
    expect((await savedIdentity(page)).documentValidationStatus).toBe("needs_review");
    const recoveredSession = await page.evaluate(() => JSON.parse(sessionStorage.getItem("up_session")));
    expect(recoveredSession.residencyVerified).not.toBe(true);
    expect(registrations).toBe(0);
  });

  test("duplicate username preserves reviewed facts, then successful registration continues without another account request", async ({
    page,
    request,
  }, info) => {
    const username = "conflict_" + Date.now();
    const existing = await request.post("/__fixture_citizen", {
      data: {
        username,
        password: "ExistingAccountPass123!",
        barangay: "Villamonte",
        reporting: false,
      },
    });
    expect(existing.status()).toBe(201);
    const owner = await existing.json();
    const registrations = [];
    const identities = [];
    page.on("response", (response) => {
      if (response.request().method() !== "POST") return;
      const path = new URL(response.url()).pathname;
      if (path === "/api/auth/register") registrations.push(response.status());
      if (path === "/api/identity") identities.push(response.status());
    });
    await signup(page);
    await captureApprovedId(page);
    let registerCalls = 0;
    await page.route("**/api/**", (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.startsWith("/api/auth/enrollment/")) return route.fallback();
      if (url.pathname === "/api/auth/register") {
        registerCalls++;
        if (registerCalls === 1) {
          return route.fulfill({ status: 409, json: { error: "Username is already registered." } });
        }
        const citizen = { id: 99, role: "citizen", username: username + "_new", barangay: "Villamonte", full_name: "Fictional Corrected Citizen", residencyVerified: true };
        return route.fulfill({ status: 201, json: { token: "synthetic-dup-session", user: citizen, identity: { documentValidationStatus: "pass" } } });
      }
      if (url.pathname === "/api/me") {
        return route.fulfill({ json: { user: { id: 99, role: "citizen", username: username + "_new", barangay: "Villamonte", residencyVerified: true } } });
      }
      if (url.pathname === "/api/identity/me") {
        const auth = route.request().headers().authorization;
        if (auth === `Bearer ${owner.token}`) return route.continue();
        return route.fulfill({ json: { identity: { documentType: "DRIVERS_LICENSE", idNumber: "N01-23-456789", fullName: "Fictional Corrected Citizen", birthDate: "1990-05-15", address: "42 FICTIONAL STREET, BACOLOD CITY", expiryDate: "2030-05-15", documentValidationStatus: "pass" } } });
      }
      if (url.pathname === "/api/identity") {
        return route.fulfill({ json: { identity: { documentValidationStatus: "pass", address: "42 FICTIONAL STREET, BACOLOD CITY" } } });
      }
      return route.fulfill({ json: [] });
    });
    await confirm(page);
    await credentials(page, username);
    await page.locator("#signupSubmitBtn").click();
    await expect(page.locator("#signupMsg")).toContainText(
      "Username is already registered. Log in or choose another username.",
    );
    await expect(page.locator("#regUser")).toBeFocused();
    await expect(page.locator("#regUser")).toHaveAttribute("aria-invalid", "true");
    expect(await page.evaluate(() => sessionStorage.getItem("up_session"))).toBeNull();
    expect(registrations).toEqual([409]);
    expect(identities).toEqual([]);
    await expect(page.locator("#regFullName")).toHaveValue("Fictional Corrected Citizen");
    await expect(page.locator("#regBirthDate")).toHaveValue("1990-05-15");
    await expect(page.locator("#regAddress")).toHaveValue("VILLAMONTE BACOLOD CITY");
    await expect(page.locator("#regIdNumber")).toHaveValue("N01-23-456789");
    await expect(page.locator("#regExpiryDate")).toHaveValue("2030-05-15");
    await expect(page.locator("#regPass")).toHaveValue("FictionalPass123!");
    await page.locator("#regUser").fill(username + "_new");
    await expect(page.locator("#regUser")).not.toHaveAttribute("aria-invalid");
    await expect(page.locator("#signupMsg")).toBeEmpty();
    await page.evaluate(() => {
      const form = document.getElementById("signupForm");
      form.requestSubmit();
      form.requestSubmit();
    });
    await expect(page).toHaveURL(/citizen.html$/);
    expect(registrations).toEqual([409, 201]);
    expect(identities).toEqual([]);
    await page.goto("/login.html?complete-identity=1");
    await page.evaluate(() => { window.autoDetectBarangay = async () => null; });
    await page.locator("#recoverIdentityBtn").click();
    await expect(page.locator("#signupMsg")).toContainText("Account already exists");
    await expect(page.locator("#regPass")).toBeEmpty();
    await expect(page.locator("#regPassConfirm")).toBeEmpty();
    await page.locator("#regAddress").fill("42 FICTIONAL STREET, BACOLOD CITY");
    await expect(page.locator("#signupSubmitBtn")).toHaveText("Save identity corrections");
    await expect(page.locator("#signupSubmitBtn")).toBeDisabled();
    await expect(page.locator("#signupSubmitStatus")).toContainText("reviewed and confirmed");
    await page.locator("#confirmIdentityBtn").click();
    await page.locator("#signupSubmitBtn").click();
    await expect(page).toHaveURL(/citizen.html$/);
    expect(registrations).toEqual([409, 201]);
    expect(identities).toEqual([200]);
    const session = await page.evaluate(() => JSON.parse(sessionStorage.getItem("up_session")));
    expect(session.id).not.toBe(owner.user.id);
    const identity = await page.evaluate(async (token) => {
      const res = await fetch("/api/identity/me", { headers: { Authorization: `Bearer ${token}` } });
      return { status: res.status, body: await res.json() };
    }, session.apiToken);
    expect(identity.status).toBe(200);
    expect(identity.body.identity.address).toBe("42 FICTIONAL STREET, BACOLOD CITY");
    const unchanged = await request.get("/api/identity/me", {
      headers: { Authorization: `Bearer ${owner.token}` },
    });
    expect(unchanged.status()).toBe(200);
    expect((await unchanged.json()).identity).toBeNull();
    await fs.mkdir(".data/registration-functional", { recursive: true });
    await page.screenshot({
      path: `.data/registration-functional/${info.project.name}-registration-complete.png`,
      fullPage: true,
    });
    expect(registrations).toEqual([409, 201]);
    expect(identities).toEqual([200]);
  });

  test("live camera capture scans a fictional multi-column license via enrollment challenge without sending OCR text or registering an account", async ({
    page,
  }, info) => {
    const rows = [
      "REPUBLIC OF THE PHILIPPINES",
      "LAND TRANSPORTATION OFFICE",
      "DRIVERS LICENSE",
      "Last Name, First Name, Middle Name",
      "SAMPLE, ALEX MORGAN",
      "Nationality   Sex   Date of Birth   Weight   Height",
      "PHL           M     1992/04/23       70       1.75",
      "Address",
      "42 FICTIONAL STREET, VILLAMONTE",
      "BACOLOD CITY",
      "License No.      Expiration Date     Agency Code",
      "N23-45-678923    2032/04/23          N23",
    ];
    const image = await sharp(
      Buffer.from(
        `<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="900"><rect width="1400" height="900" fill="white"/>${rows.map((row, index) => `<text x="40" y="${55 + index * 65}" font-family="Arial" font-size="36" fill="black">${row}</text>`).join("")}</svg>`,
      ),
    )
      .png()
      .toBuffer();
    const enrollmentPosts = [];
    const otherApiPosts = [];
    let capturePayloadText = "";
    page.on("request", (request) => {
      if (request.method() !== "POST") return;
      const pathname = new URL(request.url()).pathname;
      if (pathname.startsWith("/api/auth/enrollment/")) {
        enrollmentPosts.push(pathname);
        if (pathname === "/api/auth/enrollment/capture") {
          capturePayloadText = request.postDataBuffer()?.toString("latin1") || "";
        }
      } else if (pathname.startsWith("/api/")) {
        otherApiPosts.push(pathname);
      }
    });
    await signup(page);
    await page.evaluate(() => {
      const recognize = window.verifyGovernmentID;
      window.verifyGovernmentID = async (image) => {
        const result = await recognize(image);
        window.fictionalLayoutText = result.rawText;
        return result;
      };
    });
    await captureProvisionalId(page, false, image);
    await expect(page.locator("#regFullName")).toHaveValue("Alex Morgan Sample", {
      timeout: 90000,
    });
    await info.attach("fictional-layout-ocr", {
      body: await page.evaluate(() => window.fictionalLayoutText),
      contentType: "text/plain",
    });
    await expect(page.locator("#regBirthDate")).toHaveValue("1992-04-23");
    await expect(page.locator("#regAddress")).toHaveValue(
      /42 FICTIONAL STREET.*VILLAMONTE.*BACOLOD CITY/,
    );
    await expect(page.locator("#regIdNumber")).toHaveValue("N23-45-678923");
    await expect(page.locator("#regExpiryDate")).toHaveValue("2032-04-23");
    await expect(page.locator("#signupSubmitBtn")).toBeDisabled();
    expect(enrollmentPosts).toEqual(["/api/auth/enrollment/start", "/api/auth/enrollment/capture"]);
    expect(capturePayloadText).toContain('name="position"');
    expect(capturePayloadText).toContain('name="frames"');
    expect(capturePayloadText).not.toMatch(/SAMPLE|ALEX MORGAN|N23-45-678923|1992\/04\/23|fullName|birthDate|idNumber/);
    expect(otherApiPosts).toEqual([]);
    await fs.mkdir(".data/registration-functional", { recursive: true });
    await page.screenshot({
      path: `.data/registration-functional/${info.project.name}-automatic-id-fields.png`,
      fullPage: true,
    });
  });

  test("automatic scanning runs once, blocks duplicate scans and preserves reviewed edits", async ({
    page,
  }) => {
    await signup(page);
    await page.evaluate((text) => {
      window.scanCalls = 0;
      window.verifyGovernmentID = () => {
        window.scanCalls++;
        return new Promise((resolve) => {
          window.finishScan = () =>
            resolve({ valid: true, confidence: 90, score: 75, rawText: text });
        });
      };
    }, text);
    await page.route('**/api/auth/enrollment/options', route => route.fulfill({ json: { scanTest: false } }));
    await page.route('**/api/auth/enrollment/start', route => route.fulfill({ json: { token: 's'.repeat(43) } }));
    await page.route('**/api/auth/enrollment/capture', route => route.fulfill({
      json: {
        decision: 'BASIC_REGISTRATION_ELIGIBLE', ocrPrefillAllowed: true,
        screening: { classification: 'LOW_RISK' }
      }
    }));
    await installAlignedTestCamera(page);
    await page.locator('#idModeCameraBtn').click();
    await page.locator('#idCaptureBtn').click();
    await expect(page.locator("#idCapturedImg")).toBeVisible();
    await expect(page.locator("#idCaptureBtn")).toBeDisabled();
    await expect(page.locator("#idModeCameraBtn")).toBeDisabled();
    await page.evaluate(() => window.captureIdFromCamera());
    expect(await page.evaluate(() => window.scanCalls)).toBe(1);
    await page.evaluate(() => window.finishScan());
    await expect(page.locator("#regFullName")).toHaveValue(/Fictional Test Citizen/i);
    await page.locator("#regFullName").fill("Fictional Corrected Citizen");
    await page.locator("#confirmIdentityBtn").click();
    await page.locator("#regUser").fill("fictional_username");
    await page.locator("#regAddress").fill("Reviewed fictional address");
    await expect(page.locator("#regAddress")).toHaveValue(
      "Reviewed fictional address",
    );
    await page.locator("#confirmIdentityBtn").click();
    await expect(page.locator("#regUser")).toBeVisible();
    expect(await page.evaluate(() => window.scanCalls)).toBe(1);
  });

  test("ambiguous OCR digits and invalid expiry require correction rather than fabricated fields", async ({
    page,
  }) => {
    await signup(page);
    await fixtureOCR(page, {
      rawText: text
        .replace("N01-23-456789", "NO1-23-456789")
        .replace("2030-05-15", "2030-65-15"),
    });
    await captureProvisionalId(page);
    await expect(page.locator("#regFullName")).toHaveValue(
      "Fictional Test Citizen",
    );
    await expect(page.locator("#regIdNumber")).toHaveValue("");
    await expect(page.locator("#regExpiryDate")).toHaveValue("");
    await page.locator("#confirmIdentityBtn").click();
    await expect(page.locator("#signupSubmitBtn")).toBeDisabled();
    await page.locator("#regIdNumber").fill("N01-23-456789");
    await page.locator("#regExpiryDate").fill("2030-05-15");
    await page.locator("#regFullName").fill("Fictional Corrected Citizen");
    await page.locator("#confirmIdentityBtn").click();
    await expect(page.locator("#signupMsg")).toContainText("Identity verification is required before registration");
  });
  test("scan gate, missing facts, corrections, replacement and unsafe OCR text are handled without fake verification", async ({
    page,
    request,
  }) => {
    const seeded = await request.post("/__fixture_citizen", {
      data: { username: "scan_gate_" + Date.now(), password: "FictionalPass123!", barangay: "Villamonte", reporting: false },
    });
    expect(seeded.status()).toBe(201);
    const { token, user } = await seeded.json();
    await page.evaluate(({ token, user }) => {
      sessionStorage.setItem("up_session", JSON.stringify({
        id: user.id, username: user.username, role: user.role,
        barangay: user.barangay, fullName: user.full_name || "", apiToken: token,
      }));
    }, { token, user });
    await page.goto('/login.html?complete-identity=1');
    await page.evaluate(() => { window.autoDetectBarangay = async () => null; });
    await page.locator("#recoverIdentityBtn").click();
    await fixtureOCR(page, { valid: false, score: 20, confidence: 18 });
    await upload(page);
    await expect(page.locator("#identityFields")).toBeVisible();
    await page.locator("#confirmIdentityBtn").click();
    await expect(page.locator("#signupSubmitBtn")).toBeDisabled();
    await expect(page.locator("#signupMsg")).toContainText(
      "existing scan threshold",
    );
    await fixtureOCR(page);
    await page.locator("#verifyIdBtn").click();
    await confirm(page);
    await page
      .locator("#regFullName")
      .fill("<img src=x onerror=window.injected=true>");
    await expect(page.locator("#signupSubmitBtn")).toBeDisabled();
    expect(await page.evaluate(() => window.injected)).toBeUndefined();
    await page.locator("#regFullName").fill("");
    await page.locator("#confirmIdentityBtn").click();
    await expect(page.locator("#signupMsg")).toContainText(
      "required identity fields",
    );
    await page.locator("#govIdInput").setInputFiles({
      name: "new.png",
      mimeType: "image/png",
      buffer: documentImage,
    });
    await expect(page.locator("#regFullName")).toHaveValue(
      "Fictional Test Citizen",
    );
    await expect(page.locator("#signupSubmitBtn")).toBeDisabled();
  });
  test("real empty OCR and invalid uploads produce recoverable errors", async ({
    page,
    request,
  }) => {
    await signup(page);
    await installAlignedTestCamera(page, blank.toString("base64"));
    await page.route('**/api/auth/enrollment/options', route => route.fulfill({ json: { scanTest: false } }));
    await page.route('**/api/auth/enrollment/start', route => route.fulfill({ json: { token: 's'.repeat(43) } }));
    await page.route('**/api/auth/enrollment/capture', route => route.fulfill({
      json: {
        decision: 'VERIFICATION_REQUIRED', ocrPrefillAllowed: true,
        verificationReason: 'VERIFIER_NOT_CONFIGURED', screening: { classification: 'LOW_RISK' }
      }
    }));
    await page.locator('#idModeCameraBtn').click();
    await page.locator('#idCaptureBtn').click();
    await expect(page.locator("#idVerifyStatus")).toContainText(
      "The ID text could not be read",
      { timeout: 90000 },
    );
    const seeded = await request.post("/__fixture_citizen", {
      data: { username: "invalid_upload_" + Date.now(), password: "FictionalPass123!", barangay: "Villamonte", reporting: false },
    });
    expect(seeded.status()).toBe(201);
    const { token, user } = await seeded.json();
    await page.evaluate(({ token, user }) => {
      sessionStorage.setItem("up_session", JSON.stringify({
        id: user.id, username: user.username, role: user.role,
        barangay: user.barangay, fullName: user.full_name || "", apiToken: token,
      }));
    }, { token, user });
    await page.goto('/login.html?complete-identity=1');
    await page.evaluate(() => { window.autoDetectBarangay = async () => null; });
    await page.locator("#recoverIdentityBtn").click();
    await expect(page.locator("#signupMsg")).toContainText("Account already exists");
    await page.locator("#govIdInput").setInputFiles({
      name: "fake.png",
      mimeType: "image/png",
      buffer: Buffer.from("<svg/>"),
    });
    await expect(page.locator("#idVerifyStatus")).toContainText(
      "contents do not match",
    );
    await page.locator("#govIdInput").setInputFiles({
      name: "large.png",
      mimeType: "image/png",
      buffer: Buffer.alloc(10 * 1024 * 1024 + 1),
    });
    await expect(page.locator("#idVerifyStatus")).toContainText("10 MB");
    await expect(page.locator("#signupSubmitBtn")).toBeDisabled();
  });
  test("backend login failure never becomes a browser-only authenticated session", async ({
    page,
  }) => {
    await page.route("**/api/auth/citizen/login", (route) => route.abort());
    await page.locator("#loginUser").fill("fictional");
    await page.locator("#loginPass").fill("wrong");
    await page.locator('#loginForm button[type="submit"]').click();
    await expect(page.locator("#loginMsg")).toContainText(
      "Cannot reach the server",
    );
    expect(
      await page.evaluate(() => sessionStorage.getItem("up_session")),
    ).toBeNull();
  });

  test("cancelled OCR and worker failure cannot replace a newer reviewed image", async ({
    page,
    request,
  }) => {
    const seeded = await request.post("/__fixture_citizen", {
      data: { username: "cancel_ocr_" + Date.now(), password: "FictionalPass123!", barangay: "Villamonte", reporting: false },
    });
    expect(seeded.status()).toBe(201);
    const { token, user } = await seeded.json();
    await page.evaluate(({ token, user }) => {
      sessionStorage.setItem("up_session", JSON.stringify({
        id: user.id, username: user.username, role: user.role,
        barangay: user.barangay, fullName: user.full_name || "", apiToken: token,
      }));
    }, { token, user });
    await page.goto('/login.html?complete-identity=1');
    await page.evaluate(() => { window.autoDetectBarangay = async () => null; });
    await page.locator("#recoverIdentityBtn").click();
    await page.evaluate(() => {
      window.verifyGovernmentID = () =>
        new Promise((resolve) => {
          window.finishOldOCR = resolve;
        });
    });
    await upload(page);
    await expect(page.locator("#cancelIdScanBtn")).toBeVisible();
    await page.locator("#cancelIdScanBtn").click();
    await page.evaluate(() =>
      window.finishOldOCR({
        valid: true,
        score: 100,
        confidence: 99,
        rawText: "OLD IMAGE RESULT",
      }),
    );
    await expect(page.locator("#identityFields")).toBeHidden();
    await page.evaluate(() => {
      window.verifyGovernmentID = async () => {
        throw new Error("Controlled worker failure");
      };
    });
    await page.locator("#verifyIdBtn").click();
    await expect(page.locator("#idVerifyStatus")).toContainText(
      "Controlled worker failure",
    );
    await fixtureOCR(page);
    await page.locator("#verifyIdBtn").click();
    await confirm(page);
    await expect(page.locator("#regFullName")).toHaveValue(
      "Fictional Corrected Citizen",
    );
  });

  test("expired dates, invalid identity numbers, missing barangay and mismatched passwords cannot create an account", async ({
    page,
  }) => {
    await signup(page);
    await captureApprovedId(page);
    await page.locator("#confirmIdentityBtn").click();
    await expect(page.locator("#signupSubmitBtn")).toBeEnabled();
    await page.locator("#regExpiryDate").fill("2000-01-01");
    await page.locator("#confirmIdentityBtn").click();
    await expect(page.locator("#signupMsg")).toContainText("expired");
    await page.locator("#regExpiryDate").fill("2030-05-15");
    await page.locator("#regIdNumber").fill("invalid");
    await page.locator("#confirmIdentityBtn").click();
    await expect(page.locator("#signupMsg")).toContainText("ID number format");
    await page.locator("#regIdNumber").fill("N01-23-456789");
    await page.locator("#confirmIdentityBtn").click();
    await credentials(page, "validation_" + Date.now());
    await page.locator("#regPassConfirm").fill("not-matching");
    await page.locator("#signupSubmitBtn").click();
    await expect(page.locator("#signupMsg")).toContainText(
      "Passwords do not match",
    );
    await page.locator("#regPassConfirm").fill("FictionalPass123!");
    await page.locator("#regBarangay").selectOption("");
    await page.locator("#signupSubmitBtn").click();
    expect(
      await page
        .locator("#regBarangay")
        .evaluate((element) => element.validity.valueMissing),
    ).toBe(true);
    expect(
      await page.evaluate(() => sessionStorage.getItem("up_session")),
    ).toBeNull();
  });
  test("camera denial explains site permission recovery without upload fallback and synthetic capture releases camera tracks", async ({
    page,
  }) => {
    await signup(page);
    await page.evaluate(() => {
      navigator.mediaDevices.getUserMedia = async () => {
        throw new DOMException("Denied", "NotAllowedError");
      };
    });
    await page.locator("#idModeCameraBtn").click();
    await expect(page.locator("#idVerifyStatus")).toContainText(
      "Allow camera access for this site, then select Scan ID again.",
    );
    await expect(page.locator("#idModeUploadBtn")).toBeHidden();
    await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 900;
      canvas.height = 700;
      const ctx = canvas.getContext("2d");
      window.cameraFixture = canvas;
      window.cameraStreams = [];
      const paint = () => {
        const video = document.getElementById("idCameraVideo").getBoundingClientRect();
        const guide = document.getElementById("idCardGuide").getBoundingClientRect();
        ctx.fillStyle = "#32302e";
        ctx.fillRect(0, 0, 900, 700);
        if (video.width && guide.width) {
          const scale = Math.max(video.width / 900, video.height / 700);
          const w = guide.width / scale;
          const h = guide.height / scale;
          const x = (guide.left - video.left) / scale + (900 - video.width / scale) / 2;
          const y = (guide.top - video.top) / scale + (700 - video.height / scale) / 2;
          ctx.fillStyle = "#f2eee5";
          ctx.fillRect(x + w * 0.09, y + h * 0.09, w * 0.82, h * 0.82);
        }
      };
      setInterval(() => {
        paint();
        window.cameraStreams.forEach((stream) =>
          stream.getVideoTracks()[0].requestFrame?.(),
        );
      }, 50);
      navigator.mediaDevices.enumerateDevices = async () =>
        ["rear", "front"].map((deviceId) => ({ kind: "videoinput", deviceId }));
      navigator.mediaDevices.getUserMedia = async (options) => {
        const stream = canvas.captureStream(10);
        stream.getVideoTracks()[0].getSettings = () => ({
          deviceId: options.video.deviceId?.exact || "rear",
        });
        window.cameraStreams.push(stream);
        paint();
        return stream;
      };
    });
    await page.locator("#idModeCameraBtn").click();
    await expect
      .poll(() =>
        page.locator("#idCameraVideo").evaluate((video) => video.videoWidth),
      )
      .toBe(900);
    await page.locator("#idSwitchCamBtn").click();
    await expect
      .poll(() => page.evaluate(() => window.cameraStreams.length))
      .toBe(2);
    await expect
      .poll(() =>
        page.locator("#idCameraVideo").evaluate((video) => video.videoWidth),
      )
      .toBe(900);
    await fixtureOCR(page);
    await page.route("**/api/auth/enrollment/start", route =>
      route.fulfill({ json: { token: "c".repeat(43) } }));
    await page.route("**/api/auth/enrollment/capture", route =>
      route.fulfill({ json: {
        decision: "VERIFICATION_REQUIRED", verificationReason: "VERIFIER_NOT_CONFIGURED", ocrPrefillAllowed: true,
      } }));
    await page.locator("#idCaptureBtn").click();
    await expect(page.locator("#idCapturedImg")).toBeVisible();
    await expect(page.locator("#regFullName")).toHaveValue(
      "Fictional Test Citizen",
    );
    expect(
      await page.evaluate(() =>
        window.cameraStreams
          .flatMap((stream) => stream.getTracks())
          .every((track) => track.readyState === "ended"),
      ),
  ).toBe(true);
});
test("My Reports loads owned rows per tab without localStorage and shows server errors", async ({
  page, context, request,
}, info) => {
  const registered = await request.post("/__fixture_citizen", {
    data: {
      username: "list_" + Date.now(),
      password: "FictionalPass123!",
      barangay: "Villamonte",
    },
  });
  const body = await registered.json();
  const form = new FormData();
  for (const [key, value] of Object.entries({
    description: "Real isolated report for list regression",
    location: "Recorded report location",
    citizenCategory: "Road Damage",
    landmarkDescription: "Beside the school entrance.",
    barangay: "Villamonte",
    latitude: "10.6685",
    longitude: "122.9647",
    gpsAccuracy: "15",
    gpsFixAt: String(Date.now()),
  }))
    form.append(key, value);
  form.append("images", new File([PNG_BYTES], "one.png", { type: "image/png" }));
  form.append("images", new File([JPEG_BYTES], "two.jpg", { type: "image/jpeg" }));
  form.append("landmarkImage", new File([JPEG_BYTES], "landmark.jpg", { type: "image/jpeg" }));
  const created = await fetch(new URL("/api/reports", registered.url()), {
    method: "POST",
    headers: { Authorization: `Bearer ${body.token}` },
    body: form,
  });
  expect(created.status, await created.text()).toBe(201);
  await page.addInitScript(
    (session) => {
      if (!sessionStorage.getItem("registration-list-fixture")) {
        sessionStorage.setItem("up_session", JSON.stringify(session));
        sessionStorage.setItem("registration-list-fixture", "1");
      }
      Object.defineProperty(window, "localStorage", {
        get() {
          throw new DOMException("Blocked", "SecurityError");
        },
      });
    },
    { ...body.user, apiToken: body.token },
  );
  await page.goto("/citizen.html#my-reports");
  await expect(page.locator("#myReports")).toContainText(
    "Real isolated report for list regression",
  );
  const otherUsername = "other_" + Date.now();
  const other = await request.post("/__fixture_citizen", {
    data: { username: otherUsername, password: "FictionalPass123!", barangay: "Villamonte" },
  });
  expect(other.status()).toBe(201);
  const otherTab = await context.newPage();
  await otherTab.goto("/login.html");
  await otherTab.locator("#loginUser").fill(otherUsername);
  await otherTab.locator("#loginPass").fill("FictionalPass123!");
  await otherTab.locator('#loginForm button[type="submit"]').click();
  await expect(otherTab).toHaveURL(/citizen\.html$/);
  await otherTab.goto("/citizen.html#my-reports");
  await expect(otherTab.locator("#myReports")).toContainText("No reports submitted yet");
  await expect(otherTab.locator("#myReports")).not.toContainText("Real isolated report for list regression");
  expect(await page.evaluate(() => JSON.parse(sessionStorage.getItem("up_session")).username)).toBe(body.user.username);
  await otherTab.close();
  await page.route("**/api/reports", (route) =>
    route.fulfill({ status: 503, json: { error: "Controlled outage" } }),
  );
  await page.evaluate(() => window.syncReportsFromBackend());
  await expect(page.locator("#myReports")).toContainText("Reports could not be loaded");
  await expect(page.locator("#myReports")).not.toContainText(
    "No reports submitted yet",
  );
  await page.unroute("**/api/reports");
  await page.locator("[data-retry-reports]").click();
  await expect(page.locator("#myReports")).toContainText(
    "Real isolated report for list regression",
  );
  await page.route("**/api/reports", (route) =>
    route.fulfill({ status: 401, json: { error: "Controlled expiry" } }),
  );
  await page.evaluate(() => window.syncReportsFromBackend());
  await expect(page).toHaveURL(/login\.html(?:\?session=expired)?$/);
  await page.waitForLoadState('load');
  expect(await page.evaluate(() => sessionStorage.getItem("up_session"))).toBeNull();
  await page.unroute("**/api/reports");
  await page.locator("#loginUser").fill(body.user.username);
  await page.locator("#loginPass").fill("FictionalPass123!");
  await page.locator('#loginForm button[type="submit"]').click();
  await expect(page).toHaveURL(/citizen\.html$/);
  await page.goto('/citizen.html#my-reports');
  await expect(page.locator("#myReports")).toContainText("Real isolated report for list regression");
  await fs.mkdir(".data/registration-functional", { recursive: true });
  await page.screenshot({
    path: `.data/registration-functional/${info.project.name}-my-reports.png`,
    fullPage: true,
  });
});
test("original form structure and both appearances remain responsive", async ({
  page,
}, info) => {
  await signup(page);
  for (const theme of ["dark", "light"])
    for (const width of [375, 390, 768, 1280, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.evaluate((theme) => PortalTheme.setPreference(theme), theme);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await expect(page.locator(".login-logo")).toBeVisible();
      await expect(page.locator("#stepBarID")).toContainText(
        "VERIFY GOVERNMENT ID",
      );
      await expect(page.locator("#stepBarCreds")).toContainText(
        "SET CREDENTIALS",
      );
      await fs.mkdir(".data/registration-functional", { recursive: true });
      await page.screenshot({
        path: `.data/registration-functional/${info.project.name}-${theme}-${width}.png`,
        fullPage: true,
      });
    }
});
