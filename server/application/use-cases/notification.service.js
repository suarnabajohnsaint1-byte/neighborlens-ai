const { ValidationError, NotFoundError } = require('../../domain/errors');

const ALLOWED_TYPES = new Set([
  'report_submitted',
  'status_update',
  'report_completed',
  'barangay_review'
]);

function formatCategory(category) {
  if (!category) return 'Infrastructure';
  const clean = String(category).replace(/[^a-zA-Z0-9\s_-]/g, '').replace(/[_-]/g, ' ').trim();
  if (!clean) return 'Infrastructure';
  return clean.split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

function parseSafePositiveInteger(val, paramName) {
  if (val === undefined || val === null || val === '') return null;
  const str = String(val).trim();
  if (!/^[1-9]\d{0,10}$/.test(str)) {
    throw new ValidationError(`Invalid ${paramName}.`);
  }
  const num = Number(str);
  if (!Number.isSafeInteger(num) || num <= 0 || num > 2147483647) {
    throw new ValidationError(`Invalid ${paramName}.`);
  }
  return num;
}

function parseSafeOffset(val) {
  if (val === undefined || val === null || val === '') return 0;
  const str = String(val).trim();
  if (!/^(0|[1-9]\d{0,10})$/.test(str)) {
    throw new ValidationError('Invalid offset parameter.');
  }
  const num = Number(str);
  if (!Number.isSafeInteger(num) || num < 0 || num > 2147483647) {
    throw new ValidationError('Invalid offset parameter.');
  }
  return num;
}

function createNotificationService({ notificationRepository, notificationEvents }) {
  class NotificationService {
    async notifyPublicationReview({ userId, reportId, client }) {
      return notificationRepository.create({ userId, reportId, type: 'status_update', title: 'New post awaiting approval',
        message: `Report #${reportId} is waiting for Community Feed approval.`
      }, client);
    }
    async notifyPublicationDecision({ userId, reportId, state, reason, client }) {
      if (!['approved', 'rejected'].includes(state)) throw new ValidationError('Invalid publication outcome.');
      return notificationRepository.create({ userId, reportId, type: 'status_update',
        title: state === 'approved' ? 'Community publication approved' : 'Community publication rejected',
        message: state === 'approved' ? 'Your report has been approved for the Community Feed. Report processing continues separately.' : reason
      }, client);
    }
    async listNotifications(user, query = {}) {
      if (!user?.id) throw new ValidationError('User identification required.');

      let limit = 20;
      let offset = 0;

      if (query.limit !== undefined && query.limit !== null && query.limit !== '') {
        const parsedLimit = parseSafePositiveInteger(query.limit, 'limit parameter');
        if (parsedLimit > 100) {
          throw new ValidationError('Invalid limit parameter.');
        }
        limit = parsedLimit;
      }

      if (query.offset !== undefined && query.offset !== null && query.offset !== '') {
        offset = parseSafeOffset(query.offset);
      }

      const [notifications, unreadCount] = await Promise.all([
        notificationRepository.findByUserId(user.id, { limit, offset }),
        notificationRepository.countUnread(user.id)
      ]);

      return { notifications, unreadCount };
    }

    async getUnreadCount(user) {
      if (!user?.id) throw new ValidationError('User identification required.');
      const unreadCount = await notificationRepository.countUnread(user.id);
      return { unreadCount };
    }

    async markAsRead(id, user) {
      if (!user?.id) throw new ValidationError('User identification required.');
      const numId = parseSafePositiveInteger(id, 'notification ID');

      const existing = await notificationRepository.findById(numId, user.id);
      if (!existing || existing.userId !== user.id) {
        throw new NotFoundError('Notification not found.');
      }

      await notificationRepository.markAsRead(numId, user.id);
      const unreadCount = await notificationRepository.countUnread(user.id);

      if (notificationEvents?.publishReadSync) {
        try {
          notificationEvents.publishReadSync(user.id, { id: numId, unreadCount });
        } catch (publishErr) {
          console.error(publishErr);
        }
      }

      return { ok: true, id: numId, unreadCount };
    }

    async markAllAsRead(user) {
      if (!user?.id) throw new ValidationError('User identification required.');
      const count = await notificationRepository.markAllAsRead(user.id);
      const unreadCount = await notificationRepository.countUnread(user.id);

      if (notificationEvents?.publishReadSync) {
        try {
          notificationEvents.publishReadSync(user.id, { allRead: true, unreadCount });
        } catch (publishErr) {
          console.error(publishErr);
        }
      }

      return { ok: true, markedCount: count, unreadCount };
    }

    publishReportStatusUpdate(notification) {
      notificationEvents?.publishReportsChanged?.();
      if (notificationEvents?.publish && notification) {
        try { notificationEvents.publish(notification); }
        catch (publishErr) { console.error(publishErr); }
      }
    }

    async notifyReportStatusUpdate({ report, newStatus, oldStatus, actor, client, note, deferPublish = false }) {
      const recipientId = report?.submitted_by ?? report?.submittedBy;
      if (!recipientId) return null;

      const reportId = Number(report?.id);
      if (!Number.isSafeInteger(reportId) || reportId <= 0) return null;

      const category = formatCategory(report?.ai_category || report?.aiCategory);
      let title = 'Report status updated';
      let message = `Your ${category} report is now ${newStatus.charAt(0).toUpperCase() + newStatus.slice(1)}.`;
      let type = 'status_update';

      if (newStatus === 'resolved') {
        title = 'Report completed';
        message = `Your ${category} report has been marked Completed.`;
        type = 'report_completed';
      } else if (newStatus === 'rejected') {
        title = 'Report rejected';
        message = note ? `Reason: ${note}`.slice(0, 500) : 'Your report was rejected. Open its activity history for the reason.';
      } else if (actor?.role === 'barangay' && oldStatus === newStatus) {
        title = 'Barangay review update';
        message = 'Your submitted report has received a review update.';
        type = 'barangay_review';
      }

      if (!ALLOWED_TYPES.has(type)) {
        type = 'status_update';
      }

      const notification = await notificationRepository.create(
        {
          userId: recipientId,
          reportId,
          title,
          message,
          type
        },
        client
      );

      if (!deferPublish) this.publishReportStatusUpdate(notification);

      return notification;
    }

    async notifyReportSubmitted({ report, user, client }) {
      const recipientId = report?.submitted_by ?? report?.submittedBy ?? user?.id;
      if (!recipientId) return null;

      const reportId = Number(report?.id);
      if (!Number.isSafeInteger(reportId) || reportId <= 0) return null;

      const category = formatCategory(report?.ai_category || report?.aiCategory);
      const title = 'Report submitted';
      notificationEvents?.publishReportsChanged?.();
      const message = `Your ${category} report has been submitted and is pending review.`;
      const type = 'report_submitted';

      const notification = await notificationRepository.create(
        {
          userId: recipientId,
          reportId,
          title,
          message,
          type
        },
        client
      );

      if (notificationEvents?.publish) {
        try {
          notificationEvents.publish(notification);
        } catch (publishErr) {
          console.error(publishErr);
        }
      }

      return notification;
    }

    subscribe(userId, listener, role, barangayId) {
      if (!notificationEvents?.subscribe) return () => {};
      const stopUser = notificationEvents.subscribe(userId, listener);
      const stopReports = role === 'admin' ? notificationEvents.subscribeReports?.(listener) : null;
      const stopCommunity = ['citizen', 'barangay'].includes(role) ? notificationEvents.subscribeCommunity?.(barangayId, listener) : null;
      return () => { stopUser(); stopReports?.(); stopCommunity?.(); };
    }

    getActiveConnections(userId) {
      if (!notificationEvents?.getActiveConnections) return 0;
      return notificationEvents.getActiveConnections(userId);
    }
  }

  return new NotificationService();
}

module.exports = { createNotificationService };
