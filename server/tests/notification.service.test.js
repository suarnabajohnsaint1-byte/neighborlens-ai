const test = require('node:test');
const assert = require('node:assert/strict');
const { createNotificationService } = require('../application/use-cases/notification.service');

test('NotificationService: lists notifications and unread count', async () => {
  const mockRepo = {
    findByUserId: async (userId, opts) => [
      { id: 1, userId, reportId: 10, title: 'Test 1', message: 'Msg 1', type: 'status_update', readAt: null },
      { id: 2, userId, reportId: 11, title: 'Test 2', message: 'Msg 2', type: 'status_update', readAt: '2026-10-15T00:00:00Z' }
    ],
    countUnread: async (userId) => 1
  };
  const service = createNotificationService({ notificationRepository: mockRepo, notificationEvents: null });
  const result = await service.listNotifications({ id: 5 });

  assert.equal(result.notifications.length, 2);
  assert.equal(result.unreadCount, 1);
});

test('NotificationService: getUnreadCount returns correct count', async () => {
  const mockRepo = {
    countUnread: async (userId) => 4
  };
  const service = createNotificationService({ notificationRepository: mockRepo, notificationEvents: null });
  const result = await service.getUnreadCount({ id: 5 });

  assert.equal(result.unreadCount, 4);
});

test('NotificationService: markAsRead validates ID and marks single as read', async () => {
  let markedId = null;
  const mockRepo = {
    findById: async (id) => ({ id, userId: 5, reportId: 10, readAt: null }),
    markAsRead: async (id, userId) => { markedId = id; return true; },
    countUnread: async () => 0
  };
  const service = createNotificationService({ notificationRepository: mockRepo, notificationEvents: null });
  const result = await service.markAsRead(42, { id: 5 });

  assert.equal(result.ok, true);
  assert.equal(result.id, 42);
  assert.equal(markedId, 42);
  assert.equal(result.unreadCount, 0);
});

test('NotificationService: markAsRead rejects non-matching user', async () => {
  const mockRepo = {
    findById: async (id) => ({ id, userId: 99, reportId: 10, readAt: null })
  };
  const service = createNotificationService({ notificationRepository: mockRepo, notificationEvents: null });
  await assert.rejects(() => service.markAsRead(1, { id: 5 }), /Notification not found/);
});

test('NotificationService: markAllAsRead updates all unread', async () => {
  let calledWithUser = null;
  const mockRepo = {
    markAllAsRead: async (userId) => { calledWithUser = userId; return 3; },
    countUnread: async () => 1
  };
  const service = createNotificationService({ notificationRepository: mockRepo, notificationEvents: null });
  const result = await service.markAllAsRead({ id: 5 });

  assert.equal(result.ok, true);
  assert.equal(result.markedCount, 3);
  assert.equal(result.unreadCount, 1);
  assert.equal(calledWithUser, 5);
});

test('NotificationService: notifyReportStatusUpdate formats message and publishes event', async () => {
  let createdPayload = null;
  let publishedEvent = null;

  const mockRepo = {
    create: async (data) => {
      createdPayload = data;
      return { id: 101, ...data };
    }
  };
  const mockEvents = {
    publish: (notif) => { publishedEvent = notif; }
  };

  const service = createNotificationService({ notificationRepository: mockRepo, notificationEvents: mockEvents });
  const notif = await service.notifyReportStatusUpdate({
    report: { id: 25, submitted_by: 7, ai_category: 'road_crack' },
    newStatus: 'ongoing',
    oldStatus: 'pending',
    actor: { id: 1, role: 'admin' }
  });

  assert.equal(createdPayload.userId, 7);
  assert.equal(createdPayload.reportId, 25);
  assert.equal(createdPayload.title, 'Report status updated');
  assert.equal(createdPayload.message, 'Your Road Crack report is now Ongoing.');
  assert.equal(publishedEvent.id, 101);
});

test('NotificationService: notifyReportStatusUpdate handles completed status', async () => {
  let createdPayload = null;
  const mockRepo = {
    create: async (data) => {
      createdPayload = data;
      return { id: 102, ...data };
    }
  };

  const service = createNotificationService({ notificationRepository: mockRepo, notificationEvents: null });
  await service.notifyReportStatusUpdate({
    report: { id: 30, submitted_by: 8, ai_category: 'drainage' },
    newStatus: 'resolved',
    oldStatus: 'ongoing',
    actor: { id: 1, role: 'admin' }
  });

  assert.equal(createdPayload.title, 'Report completed');
  assert.equal(createdPayload.message, 'Your Drainage report has been marked Completed.');
  assert.equal(createdPayload.type, 'report_completed');
});

test('NotificationService: notifyReportSubmitted creates notification and publishes event', async () => {
  let createdPayload = null;
  let publishedEvent = null;

  const mockRepo = {
    create: async (data) => {
      createdPayload = data;
      return { id: 103, ...data };
    }
  };
  const mockEvents = {
    publish: (notif) => { publishedEvent = notif; }
  };

  const service = createNotificationService({ notificationRepository: mockRepo, notificationEvents: mockEvents });
  await service.notifyReportSubmitted({
    report: { id: 44, submitted_by: 9, ai_category: 'pothole' },
    user: { id: 9 }
  });

  assert.equal(createdPayload.userId, 9);
  assert.equal(createdPayload.reportId, 44);
  assert.equal(createdPayload.title, 'Report submitted');
  assert.equal(createdPayload.message, 'Your Pothole report has been submitted and is pending review.');
  assert.equal(createdPayload.type, 'report_submitted');
  assert.equal(publishedEvent.id, 103);
});

