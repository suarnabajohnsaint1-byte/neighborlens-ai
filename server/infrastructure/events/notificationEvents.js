const { EventEmitter } = require('node:events');

class NotificationBroadcaster extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(200);
  }

  publish(notification) {
    if (!notification || !notification.userId) return;
    this.emit(`user:${notification.userId}`, notification);
  }

  publishReadSync(userId, payload) {
    if (!userId) return;
    this.emit(`user:${userId}`, {
      event: 'read_sync',
      ...payload
    });
  }

  revoke(userId) {
    if (!userId) return;
    this.emit(`user:${userId}`, { event: 'session_revoked' });
  }

  subscribe(userId, listener) {
    const channel = `user:${userId}`;
    this.on(channel, listener);
    return () => {
      this.off(channel, listener);
    };
  }

  publishReportsChanged() {
    this.emit('admin:reports', { event: 'reports_changed' });
  }

  subscribeReports(listener) {
    this.on('admin:reports', listener);
    return () => this.off('admin:reports', listener);
  }

  publishCommunityChanged(barangayId, payload) {
    this.emit('community:citywide', { event: 'community_changed', postId: payload.postId, kind: payload.kind });
  }

  subscribeCommunity(barangayId, listener) {
    const channel = 'community:citywide';
    this.on(channel, listener);
    return () => this.off(channel, listener);
  }

  getActiveConnections(userId) {
    if (!userId) return 0;
    return this.listenerCount(`user:${userId}`);
  }
}

module.exports = new NotificationBroadcaster();
