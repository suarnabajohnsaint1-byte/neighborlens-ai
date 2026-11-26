const test = require('node:test');
const assert = require('node:assert/strict');
const events = require('../infrastructure/events/notificationEvents');
const { createNotificationService } = require('../application/use-cases/notification.service');

test('committed report notifications invalidate admin dashboards without leaking report data to other roles', async () => {
  const service = createNotificationService({ notificationEvents: events, notificationRepository: { create: async value => ({ id: 9, ...value }) } });
  const admin = [], citizen = [], official = [];
  const stop = [service.subscribe(1, event => admin.push(event), 'admin'), service.subscribe(2, event => citizen.push(event), 'citizen'), service.subscribe(3, event => official.push(event), 'barangay')];
  try {
    const report = { id: 42, submitted_by: 2, ai_category: 'pothole' };
    await service.notifyReportSubmitted({ report });
    await service.notifyReportStatusUpdate({ report, oldStatus: 'pending', newStatus: 'ongoing', actor: { role: 'admin' } });
    assert.deepEqual(admin, [{ event: 'reports_changed' }, { event: 'reports_changed' }]);
    assert.equal(citizen.length, 2);
    assert.equal(citizen.some(event => event.event === 'reports_changed'), false);
    assert.deepEqual(official, []);
  } finally { stop.forEach(unsubscribe => unsubscribe()); }
  assert.equal(events.getActiveConnections(1), 0);
  assert.equal(events.listenerCount('admin:reports'), 0);
});
