const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { randomBytes } = require("node:crypto");

const { startSignedEnrollment } = require('../support/signed-enrollment');
const { privateMysql, waitExit } = require("../support/private-mysql");

test(
  "private MySQL verifies existing-form browser OCR, auth, identity persistence and reports",
  { timeout: 600000 },
  async (t) => {
    const { pool, adapter, directory, close } = await privateMysql(t);
    let server, enrollment;
    try {
      const {
        readMigration,
        listMigrationFiles,
      } = require("../../server/infrastructure/database/mysql/migrationRunner");
      for (const file of await listMigrationFiles())
        for (const statement of (await readMigration(file)).statements)
          await pool.query(statement);
      require("../../server/infrastructure/database").useTestDatabase(adapter);
      process.env.JWT_SECRET = randomBytes(32).toString("hex");
      process.env.STORAGE_DRIVER = "local";
      process.env.UPLOAD_DIR = path.join(directory, "private-uploads");
      enrollment = await startSignedEnrollment();
      const { DamageDetectionError } = require("../../server/domain/errors");
      const { damageDetectionService } = require("../../server/composition");
      damageDetectionService.processDamageImage = async () => {
        throw new DamageDetectionError(
          "Isolated unavailable inference",
          "INFERENCE_NETWORK",
          502,
        );
      };
      damageDetectionService.verifyDamagePair = async () => {
        throw new DamageDetectionError(
          "Isolated unavailable inference",
          "INFERENCE_NETWORK",
          502,
        );
      };
      const app = require("../../server/app");
      server = await new Promise((resolve) => {
        const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
      });
      const base = `http://127.0.0.1:${server.address().port}`;
      const post = (endpoint, data, token) =>
        fetch(base + endpoint, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify(data),
        });

      await t.test("signed registration persists one locked identity and bcrypt credentials", async () => {
        const credentials = { username: 'fictional_mysql', password: 'FictionalPass123!', barangay: 'Villamonte' };
        const payload = await enrollment.registrationPayload(base, credentials);
        const created = await post('/api/auth/register', payload);
        assert.equal(created.status, 201);
        const account = await created.json();
        assert.equal(account.user.full_name, payload.identity.fullName);
        assert.equal(account.user.residencyVerified, true);
        assert.equal((await post('/api/auth/login', { ...credentials, password: 'wrong' })).status, 401);
        assert.equal((await post('/api/auth/register', await enrollment.registrationPayload(base, credentials))).status, 409);
        const [users] = await pool.execute('SELECT password_hash FROM users WHERE id = ?', [account.user.id]);
        assert.ok(require('../../server/infrastructure/security/passwordHasher').verify(credentials.password, users[0].password_hash));

        const login = await post('/api/auth/login', credentials);
        assert.equal(login.status, 200);
        const { token } = await login.json();
        assert.equal((await post('/api/identity', payload.identity)).status, 401);
        const attempts = await Promise.all([1, 2, 3].map(() => post('/api/identity', {
          ...payload.identity, expiryDate: '2000-01-01', userId: 999, documentValidationStatus: 'pass'
        }, token)));
        assert.deepEqual(attempts.map(result => result.status), [403, 403, 403]);
        const [rows] = await pool.execute('SELECT full_name, birth_date, address FROM citizen_identities WHERE user_id = ?', [account.user.id]);
        assert.deepEqual(rows, [{ full_name: payload.identity.fullName, birth_date: payload.identity.birthDate, address: payload.identity.address }]);
        const stored = await fetch(base + '/api/identity/me', { headers: { Authorization: 'Bearer ' + token } });
        assert.equal((await stored.json()).identity.documentValidationStatus, 'pass');
      });
      await t.test(
        "existing Admin and Barangay credentials retain API login and role routing",
        async () => {
          const { chromium, expect } = require("@playwright/test");
          const browser = await chromium.launch();
          try {
            for (const role of ["admin", "barangay"]) {
              const username = "fictional_" + role;
              const password = "FictionalOfficialPass123!";
              await pool.execute(
                "INSERT INTO users (username, password_hash, role, barangay, barangay_id) VALUES (?, ?, ?, ?, ?)",
                [
                  username,
                  require("../../server/infrastructure/security/passwordHasher").hash(
                    password,
                  ),
                  role,
                  "Villamonte",
                  role === "barangay" ? 60 : null,
                ],
              );
              const page = await browser.newPage();
              await page.addInitScript(() =>
                Object.defineProperty(window, "NEIGHBORLENS_API_BASE_URL", {
                  configurable: true,
                  get: () => location.origin,
                  set() {},
                }),
              );
              const wrongPortal = await fetch(base + "/api/auth/citizen/login", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ username, password }),
              });
              assert.equal(wrongPortal.status, 401);
              await page.goto(base + "/" + role + "-login.html");
              await page.locator("#roleLoginUser").fill(username);
              await page.locator("#roleLoginPass").fill(password);
              await page.locator("#roleLoginSubmit").click();
              await expect(page).toHaveURL(new RegExp("/" + role + "\\.html(?:#.*)?$"));
              await page.close();
            }
          } finally {
            await browser.close();
          }
        },
      );
      await t.test(
        "desktop and mobile existing UI uses real Tesseract, real API and private MySQL",
        async () => {

          const localAssets = path.resolve('.data/enrollment-browser-assets/node_modules');
          const assets = process.env.ENROLLMENT_TEST_BROWSER_ASSETS || await fs.access(localAssets).then(() => localAssets, () => '');
          for (const project of ['desktop', 'mobile']) {
            const facts = await enrollment.prepareFacts('Villamonte');
            const child = spawn(process.execPath, [
              require.resolve('@playwright/test/cli'), 'test', '--config=playwright.registration.config.js',
              '--project', project, '-g', 'verified live scanner enrollment'
            ], {
              env: {
                ...process.env, REGISTRATION_TEST_URL: base, REGISTRATION_VERIFIED_FIXTURE_NUMBER: facts.idNumber,
                ENROLLMENT_TEST_BROWSER_ASSETS: assets
              },
              windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']
            });
            let output = '';
            child.stdout.on('data', data => { output += data; });
            child.stderr.on('data', data => { output += data; });
            let code;
            try { code = await waitExit(child, 100000); }
            finally { t.diagnostic(output); }
            assert.equal(code, 0, 'Private MySQL scanner browser check failed on ' + project);
          }
          const [rows] = await pool.execute(
            "SELECT u.id, i.user_id, i.full_name FROM users u JOIN citizen_identities i ON i.user_id = u.id WHERE u.username LIKE ?",
            ["functional_%"],
          );
          assert.equal(rows.length, 2);
          for (const row of rows) {
            assert.equal(row.id, row.user_id);
            assert.equal(row.full_name, "Synthetic Test Citizen");
          }
        },
      );
    } finally {
      if (server) await new Promise((resolve) => server.close(resolve));
      enrollment?.close();
      await close();
    }
  },
);
