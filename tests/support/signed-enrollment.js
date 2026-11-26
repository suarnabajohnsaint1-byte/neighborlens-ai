const assert = require('node:assert/strict');
const { createHash, createHmac, randomBytes } = require('node:crypto');
const { createServer } = require('node:http');
const sharp = require('sharp');
const { installFixtureBarangay, reportGpsFields } = require('./citizens');

async function startSignedEnrollment() {
  const verifierSecret = randomBytes(32).toString('hex');
  const fraudSecret = randomBytes(32).toString('hex');
  let serial = 400000;
  let currentFacts;
  const clear = { monitorRecapture: 'clear', digitalManipulation: 'clear', imageReuse: 'clear' };
  const provider = createServer(async (req, res) => {
    try {
      const fraud = req.url === '/fraud';
      const secret = fraud ? fraudSecret : verifierSecret;
      assert.equal(req.headers.authorization, `Bearer ${secret}`);
      const form = await new Response(req, { headers: { 'content-type': req.headers['content-type'] } }).formData();
      const bytes = Buffer.from(await form.get('frames').arrayBuffer());
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const result = fraud
        ? { purpose: 'registration_fraud_assessment', assessment: 'clear', checks: clear }
        : { status: 'approved', issuerVerified: true, holderVerified: true, liveCapturePassed: true,
            subject: `synthetic-${currentFacts.idNumber}`, facts: currentFacts, fraudScreening: clear };
      const body = JSON.stringify({ captureId: form.get('captureId'), framesSha256: [sha256], ...result });
      res.setHeader('Content-Type', 'application/json');
      res.setHeader(`X-Registration-${fraud ? 'Fraud' : 'Verifier'}-Signature`, createHmac('sha256', secret).update(body).digest('hex'));
      res.end(body);
    } catch {
      res.writeHead(500).end();
    }
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${provider.address().port}`;
  Object.assign(process.env, {
    REGISTRATION_VERIFIER_URL: origin + '/issuer', REGISTRATION_VERIFIER_SECRET: verifierSecret,
    REGISTRATION_FRAUD_URL: origin + '/fraud', REGISTRATION_FRAUD_SECRET: fraudSecret,
    REGISTRATION_FINGERPRINT_KEY: randomBytes(32).toString('hex')
  });

  function post(baseUrl, endpoint, data, token) {
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    if (!(data instanceof FormData)) headers['Content-Type'] = 'application/json';
    return fetch(`${baseUrl}/api/auth/${endpoint}`, { method: 'POST', headers,
      body: data instanceof FormData ? data : JSON.stringify(data) });
  }

  async function prepareFacts(barangay) {
    await installFixtureBarangay(barangay);
    currentFacts = {
      documentType: 'DRIVERS_LICENSE', idNumber: `N01-23-${++serial}`, fullName: 'Synthetic Test Citizen',
      address: `42 FIXTURE STREET, ${barangay}, BACOLOD CITY`, birthDate: '1990-05-15', expiryDate: '2099-01-01'
    };
    return currentFacts;
  }

  return {
    close: () => provider.close(),
    prepareFacts,
    async registrationPayload(baseUrl, { username, password, barangay = 'Barangay 1' }) {
      await prepareFacts(barangay);
      const { latitude, longitude, gpsAccuracy } = reportGpsFields(barangay);
      const position = () => ({ latitude, longitude, accuracy: gpsAccuracy, timestamp: Date.now() });
      const start = await post(baseUrl, 'enrollment/start', { position: position() });
      const started = await start.json();
      assert.equal(start.status, 200, JSON.stringify(started));
      const image = await sharp(Buffer.from(`<svg width="640" height="400"><rect width="640" height="400" fill="white"/>
        <text x="30" y="180" fill="black" font-size="40">SYNTHETIC FIXTURE ${serial}</text></svg>`)).jpeg().toBuffer();
      const form = new FormData();
      form.set('position', JSON.stringify(position()));
      form.set('frames', new Blob([image], { type: 'image/jpeg' }), 'fixture.jpg');
      const capture = await post(baseUrl, 'enrollment/capture', form, started.token);
      const approved = await capture.json();
      assert.equal(capture.status, 200, JSON.stringify(approved));
      assert.equal(approved.decision, 'VERIFIED');
      return { username, password, barangay, token: started.token, identity: approved.facts, position: position() };
    }
  };
}

module.exports = { startSignedEnrollment };
