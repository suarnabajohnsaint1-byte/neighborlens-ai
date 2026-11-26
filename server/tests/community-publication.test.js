const test = require('node:test');
const assert = require('node:assert/strict');
const { createCommunityPublicationService } = require('../application/use-cases/communityPublication.service');

function fixture() {
  const calls = [];
  const service = createCommunityPublicationService({
    getDatabase: () => ({ withTransaction: async work => work({}) }),
    repository: { admins: async () => [{ id: 3, status: 'active', token_version: 0 }], lockReport: async () => ({ id: 1, submitted_by: 1, barangay_id: 1, description: 'Fixture', status: 'pending' }), find: async () => null },
    media: { fingerprint: () => 'a'.repeat(64) },
    audit: { writeAudit: async (...values) => calls.push(values) }, events: {}
  });
  return { service, calls };
}
const citizen = { id: 1, role: 'citizen', barangayId: 1, tokenVersion: 0 };
const admin = { id: 3, role: 'admin', tokenVersion: 0 };

for (const role of ['citizen', 'barangay', undefined]) test(`service rejects ${role || 'anonymous'} moderation without database reliance`, async () => {
  const { service } = fixture();
  await assert.rejects(service.decide({ ...citizen, role }, 1, { state: 'approved', version: 1 }), /Only Admin/);
  await assert.rejects(service.assign({ ...citizen, role }, 1), /Only Admin/);
  await assert.rejects(service.queue({ ...citizen, role }), /Only Admin/);
});
for (const state of ['pending', 'resolved', 'approved ', null]) test(`rejects invalid publication outcome ${state}`, async () => {
  await assert.rejects(fixture().service.decide(admin, 1, { state, version: 1 }), /Invalid publication decision/);
});
for (const reason of ['', ' ', 'a'.repeat(501), null, 123]) test(`rejects invalid publication rejection reason ${String(reason).slice(0, 15)}`, async () => {
  await assert.rejects(fixture().service.decide(admin, 1, { state: 'rejected', reason, version: 1 }), /Enter text/);
});
for (const version of [0, -1, '1e2', 2147483648]) test(`rejects malformed publication version ${version}`, async () => {
  await assert.rejects(fixture().service.decide(admin, 1, { state: 'approved', version }), /Invalid community record/);
});
test('foreign owner cannot request publication and no audit is written', async () => {
  const { service, calls } = fixture();
  await assert.rejects(service.request({ ...citizen, id: 2 }, { reportId: 1, requestKey: 'fixture-request-1234' }), /Only your own/);
  assert.deepEqual(calls, []);
});
test('Barangay cannot submit citizen publication requests', async () => {
  await assert.rejects(fixture().service.request({ ...citizen, role: 'barangay' }, { reportId: 1, requestKey: 'fixture-request-1234' }), /Only citizens/);
});
test('stale Admin sessions cannot access the publication queue', async () => {
  await assert.rejects(fixture().service.queue({ ...admin, tokenVersion: 2 }), /active Admin session/);
});
