# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: tests\browser\registration.spec.js >> real-format LTO driver's license extracts full name, birthdate, provincial camp address and ID number
- Location: tests\browser\registration.spec.js:385:1

# Error details

```
Error: page.goto: Protocol error (Page.navigate): Cannot navigate to invalid URL
Call log:
  - navigating to "/login.html", waiting until "load"

```

# Test source

```ts
  1   | const { test, expect } = require("@playwright/test");
  2   | const sharp = require("sharp");
  3   | const fs = require("node:fs/promises");
  4   | 
  5   | const text =
  6   |   "REPUBLIC OF THE PHILIPPINES\nLAND TRANSPORTATION OFFICE\nDRIVERS LICENSE\nFULL NAME: FICTIONAL TEST CITIZEN\nDATE OF BIRTH: 1990-05-15\nLICENSE NO: N01-23-456789\nADDRESS: VILLAMONTE BACOLOD CITY\nEXPIRATION DATE: 2030-05-15";
  7   | let documentImage;
  8   | let blank;
  9   | test.beforeAll(async () => {
  10  |   documentImage = await sharp(
  11  |     Buffer.from(
  12  |       `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="760"><rect width="1200" height="760" fill="white"/>${text
  13  |         .split("\n")
  14  |         .map(
  15  |           (line, index) =>
  16  |             `<text x="45" y="${65 + index * 75}" font-family="Arial" font-size="36" fill="black">${line}</text>`,
  17  |         )
  18  |         .join("")}</svg>`,
  19  |     ),
  20  |   )
  21  |     .png()
  22  |     .toBuffer();
  23  |   blank = await sharp({
  24  |     create: { width: 500, height: 320, channels: 3, background: "white" },
  25  |   })
  26  |     .png()
  27  |     .toBuffer();
  28  | });
  29  | test.beforeEach(async ({ page }) => {
  30  |   page.errors = [];
  31  |   page.on("pageerror", (error) => page.errors.push(error.message));
  32  |   await page.addInitScript(() =>
  33  |     Object.defineProperty(window, "NEIGHBORLENS_API_BASE_URL", {
  34  |       configurable: true,
  35  |       get: () => location.origin,
  36  |       set() {},
  37  |     }),
  38  |   );
> 39  |   await page.goto("/login.html");
      |              ^ Error: page.goto: Protocol error (Page.navigate): Cannot navigate to invalid URL
  40  |   await page.evaluate(() => {
  41  |     window.autoDetectBarangay = async () => null;
  42  |   });
  43  | });
  44  | test.afterEach(async ({ page }) => expect(page.errors).toEqual([]));
  45  | async function signup(page) {
  46  |   await page.getByRole("link", { name: "Create Account", exact: true }).click();
  47  |   await page.locator("#regBarangay").selectOption("Villamonte");
  48  | }
  49  | async function upload(page, buffer = documentImage) {
  50  |   const picker = page.waitForEvent("filechooser");
  51  |   await page.locator("#idModeUploadBtn").click();
  52  |   await (
  53  |     await picker
  54  |   ).setFiles({ name: "fictional-id.png", mimeType: "image/png", buffer });
  55  |   await expect(page.locator("#govIdPreview")).toBeVisible();
  56  | }
  57  | async function fixtureOCR(page, overrides = {}) {
  58  |   await page.evaluate(
  59  |     ({ text, overrides }) => {
  60  |       window.verifyGovernmentID = async () => ({
  61  |         valid: true,
  62  |         score: 55,
  63  |         confidence: 92,
  64  |         rawText: text,
  65  |         ...overrides,
  66  |       });
  67  |     },
  68  |     { text, overrides },
  69  |   );
  70  | }
  71  | async function confirm(page) {
  72  |   await expect(page.locator("#regFullName")).toHaveValue(
  73  |     /Fictional Test Citizen/i,
  74  |   );
  75  |   await page.locator("#regFullName").fill("Fictional Corrected Citizen");
  76  |   await page.locator("#confirmIdentityBtn").click();
  77  |   await expect(page.locator("#signupSubmitBtn")).toBeEnabled();
  78  | }
  79  | async function credentials(page, username) {
  80  |   await page.locator("#regUser").fill(username);
  81  |   await page.locator("#regPass").fill("FictionalPass123!");
  82  |   await page.locator("#regPassConfirm").fill("FictionalPass123!");
  83  | }
  84  | async function logout(page, project) {
  85  |   if (project === "mobile") await page.locator(".portal-account-toggle").click();
  86  |   await page.getByRole("button", { name: "Log out", exact: true }).click();
  87  |   await expect(page).toHaveURL(/login.html$/);
  88  |   expect(await page.evaluate(() => sessionStorage.getItem("up_session"))).toBeNull();
  89  | }
  90  | async function savedIdentity(page) {
  91  |   const session = await page.evaluate(() => JSON.parse(sessionStorage.getItem("up_session")));
  92  |   const response = await page.request.get("/api/identity/me", {
  93  |     headers: { Authorization: `Bearer ${session.apiToken}` },
  94  |   });
  95  |   expect(response.status()).toBe(200);
  96  |   return (await response.json()).identity;
  97  | }
  98  | test('OCR rescan preserves user corrections even when recognition returns empty fields', async ({ page }) => {
  99  |   await signup(page);
  100 |   await fixtureOCR(page);
  101 |   await upload(page);
  102 |   await expect(page.locator('#regBirthDate')).toHaveValue('1990-05-15');
  103 |   await page.locator('#regFullName').fill('Fictional Reviewed Citizen');
  104 |   await page.locator('#regBirthDate').fill('2001-09-15');
  105 |   await fixtureOCR(page, { fields: {
  106 |     fullName: '', birthDate: '', address: 'VILLAMONTE BACOLOD CITY',
  107 |     idType: 'DRIVERS_LICENSE', idNumber: 'N01-23-456789', expiryDate: '2030-05-15'
  108 |   } });
  109 |   await page.locator('#verifyIdBtn').click();
  110 |   await expect(page.locator('#verifyIdBtn')).toBeEnabled();
  111 |   await expect(page.locator('#regFullName')).toHaveValue('Fictional Reviewed Citizen');
  112 |   await expect(page.locator('#regBirthDate')).toHaveValue('2001-09-15');
  113 |   await page.locator('#confirmIdentityBtn').click();
  114 |   await expect(page.locator('#signupSubmitBtn')).toBeEnabled();
  115 | });
  116 | test('delayed OCR cannot overwrite a correction made after the scan started', async ({ page }) => {
  117 |   await signup(page);
  118 |   await fixtureOCR(page);
  119 |   await upload(page);
  120 |   await expect(page.locator('#regBirthDate')).toHaveValue('1990-05-15');
  121 |   await page.evaluate(() => {
  122 |     window.verifyGovernmentID = () => new Promise(resolve => { window.resolveDelayedScan = resolve; });
  123 |   });
  124 |   await page.locator('#verifyIdBtn').click();
  125 |   await expect(page.locator('#regFullName')).toBeDisabled();
  126 |   await page.evaluate(() => {
  127 |     for (const [id, value] of [['regFullName', 'Fictional Later Correction'], ['regBirthDate', '2001-09-15']]) {
  128 |       const input = document.getElementById(id);
  129 |       input.value = value;
  130 |       input.dispatchEvent(new Event('input', { bubbles: true }));
  131 |     }
  132 |   });
  133 |   await page.evaluate(text => window.resolveDelayedScan({ valid: true, score: 55, confidence: 92, rawText: text }), text);
  134 |   await expect(page.locator('#verifyIdBtn')).toBeEnabled();
  135 |   await expect(page.locator('#regFullName')).toHaveValue('Fictional Later Correction');
  136 |   await expect(page.locator('#regBirthDate')).toHaveValue('2001-09-15');
  137 | });
  138 | test('an explicit replacement scan repopulates a deliberately cleared field', async ({ page }) => {
  139 |   await signup(page);
```