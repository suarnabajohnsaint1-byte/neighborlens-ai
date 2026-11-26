const { Readable } = require('node:stream');
const { createHash, createHmac } = require('node:crypto');
const sharp = require('sharp');
const clearChecks = { monitorRecapture: 'clear', digitalManipulation: 'clear', imageReuse: 'clear' };

module.exports = async function verifyFixture(req, res) {
  const fraudRequest = req.url === '/__fixture_screen_id';
  const secret = fraudRequest ? process.env.REGISTRATION_FRAUD_SECRET : process.env.REGISTRATION_VERIFIER_SECRET;
  if (req.headers.authorization !== `Bearer ${secret}`) {
    res.writeHead(403).end();
    return;
  }
  try {
    const payload = new Response(Readable.toWeb(req), { headers: { 'content-type': req.headers['content-type'] } });
    const fields = await payload.formData();
    const frames = fields.getAll('frames');
    const captureId = fields.get('captureId');
    if (frames.length !== 1 || !/^[A-Za-z0-9_-]{32}$/.test(captureId)) throw new Error('Invalid synthetic capture');
    const image = Buffer.from(await frames[0].arrayBuffer());
    const framesSha256 = [createHash('sha256').update(image).digest('hex')];
    const reply = (result, service) => {
      const body = JSON.stringify({ captureId, framesSha256, ...result });
      res.writeHead(200, { 'Content-Type': 'application/json',
        [`X-Registration-${service}-Signature`]: createHmac('sha256', secret).update(body).digest('hex') }).end(body);
    };
    if (fraudRequest) {
      reply({ purpose: 'registration_fraud_assessment', assessment: 'clear', checks: clearChecks }, 'Fraud');
      return;
    }
    const subject = createHash('sha256').update(image).digest('hex');
    // Colour markers identify the independent expected facts for each synthetic fixture.
    const [red, green, blue] = await sharp(image).extract({ left: 0, top: 0, width: 1, height: 1 }).raw().toBuffer();
    if (red - blue > 28) {
      reply({ status: 'pending_review' }, 'Verifier');
      return;
    }
    reply({
      subject, status: 'approved', issuerVerified: true, holderVerified: true,
      liveCapturePassed: true,
      fraudScreening: clearChecks,
      facts: green - red > 28 ? {
        documentType: 'DRIVERS_LICENSE', idNumber: blue - red > 20 ? 'N23-45-678924' : 'N23-45-678923',
        fullName: 'Alex Morgan Sample', birthDate: '1992-04-23',
        address: '42 FICTIONAL STREET, VILLAMONTE, BACOLOD CITY', expiryDate: '2032-04-23'
      } : {
        documentType: 'PHILSYS', idNumber: blue - red > 25 ? '1234-5678-9012-3457' : '1234-5678-9012-3456',
        fullName: 'Josie Santos Reyes Dela Cruz',
        birthDate: '1999-07-11', address: 'LOT 5 BLOCK 2, SAMPLE STREET, VILLAMONTE, BACOLOD CITY', expiryDate: null
      }
    }, 'Verifier');
  } catch {
    res.writeHead(400).end();
  }
};
