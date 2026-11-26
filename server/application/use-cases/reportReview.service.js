const { createHash } = require('node:crypto');
const { ForbiddenError, ValidationError, ConflictError } = require('../../domain/errors');
const { authorizeReportAccess } = require('../../domain/reports/report.rules');
const { evaluateSeverity, FIELDS } = require('../../domain/reports/reportSeverity.rules');

const positive = (value, zero = false) => {
  const text = String(value ?? (zero ? 0 : ''));
  if (!/^(0|[1-9]\d*)$/.test(text) || !Number.isSafeInteger(Number(text)) || (!zero && Number(text) === 0)) throw new ValidationError('Invalid record identifier.');
  return Number(text);
};
const text = (value, label, minimum = 1) => {
  if (typeof value !== 'string' || value.trim().length < minimum || value.trim().length > 500 || !/[\p{L}\p{N}]/u.test(value)) throw new ValidationError(`${label} must contain ${minimum} to 500 characters of meaningful text.`);
  return value.trim();
};
const requestKey = value => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(value)) throw new ValidationError('A valid request key is required.');
  return value;
};

function createReportReviewService({ getDatabase, reportService, reports, repository, community, incidents, audit, notifications, events, clock, policy = {} }) {
  async function access(id, user, client) {
    if (!['admin', 'barangay'].includes(user?.role)) throw new ForbiddenError('Internal report review is restricted to authorized staff.');
    if (!client) return reportService.findAuthorizedReport(positive(id), user);
    const report = await reports.findByIdForUpdate(id, client);
    if (!report || !authorizeReportAccess(report, user).allowed) throw new ForbiddenError('Report is no longer available in your jurisdiction.');
    return report;
  }
  async function history(id, client = getDatabase()) {
    const offset = await clock.offsetMinutes(getDatabase(), client);
    return (await repository.severityHistory(id, client)).map(row => ({ id: row.id, category: row.category, classification: row.classification, priority: row.priority,
      previousClassification: row.previous_classification, previousPriority: row.previous_priority, reason: row.reason,
      evidence: typeof row.evidence === 'string' ? JSON.parse(row.evidence) : row.evidence, policyVersion: row.policy_version,
      recommendation: row.recommendation, reviewedBy: row.username || 'Former staff member', createdAt: clock.utc(row.created_at, offset) }));
  }
  return {
    async comments(id, user, query = {}) {
      const report = await access(id, user), before = positive(query.before ?? 0, true);
      const incidentReady = incidents && await incidents.ready(getDatabase());
      return getDatabase().withTransaction(async client => {
        if (incidentReady) await incidents.lock(client);
        const current = await access(report.id, user, client);
        const linked = await community.byReportId(report.id, client);
        const membership = incidentReady ? await incidents.membership(report.id, client) : null;
        const canonical = membership?.canonical_post_id || null;
        const discussions = membership ? await incidents.posts(membership.id, client) : linked ? [linked] : [];
        const selected = query.discussion ? positive(query.discussion) : canonical || linked?.id || 0;
        if (query.discussion && !discussions.some(item => Number(item.id) === selected)) throw new ForbiddenError('This discussion does not belong to the report incident.');
        const post = await community.find(selected, current.barangay_id, client);
        if (!post) return { comments: [], hasMore: false, published: false };
        const rows = await repository.citizenComments(post.id, before, client), offset = await clock.offsetMinutes(getDatabase(), client);
        return { published: true, discussionId: post.id, discussions: discussions.map(item => ({ postId: Number(item.id), canonical: Number(item.id) === Number(canonical || linked?.id), archived: Boolean(canonical) && Number(item.id) !== Number(canonical) })), hasMore: rows.length > 30, comments: rows.slice(0, 30).reverse().map(row => ({ id: row.id, body: row.body, parentId: row.parent_id, author: row.display_name || 'Citizen', avatarVariant: Number(row.avatar_variant || 0), createdAt: clock.utc(row.created_at, offset) })) };
      });
    },
    async load(id, user, query = {}) {
      const report = await access(id, user);
      const before = positive(query.before ?? 0, true);
      return getDatabase().withTransaction(async client => {
        await access(report.id, user, client);
        const rows = await repository.messages(report.id, before, 51, client);
        const offset = await clock.offsetMinutes(getDatabase(), client);
        return { messages: rows.slice(0, 50).reverse().map(row => ({ id: row.id, body: row.body, senderId: row.sender_id, sender: row.username || 'Former staff member', role: row.sender_role, createdAt: clock.utc(row.created_at, offset), mine: Number(row.sender_id) === Number(user.id) })),
          hasMore: rows.length > 50, unreadCount: await repository.unread(report.id, user.id, client), severityHistory: await history(report.id, client), fields: FIELDS, policyVersion: policy.version || 'manual-review-v1' };
      });
    },
    async send(id, user, body = {}) {
      const report = await access(id, user), value = text(body.body, 'Message'), key = requestKey(body.requestKey);
      const delivered = [];
      const result = await getDatabase().withTransaction(async client => {
        const current = await access(report.id, user, client);
        const prior = await repository.messageRequest(report.id, user.id, key, client);
        if (prior) {
          if (prior.body !== value) throw new ConflictError('This request key belongs to another message.');
          return { id: prior.id, replayed: true };
        }
        const created = await repository.createMessage(report.id, user, value, key, client);
        const recipients = (await repository.recipients(current, user, client))
          .filter(recipient => authorizeReportAccess(current, recipient).allowed);
        await audit.writeAudit(user.id, 'coordination_message', 'report', report.id, client, {
          message_id: created.insertId, notification_recipient_count: recipients.length
        });
        for (const recipient of recipients) {
          delivered.push(await notifications.create({ userId: recipient.id, reportId: report.id, type: 'coordination_message', title: 'New internal report message', message: `Authorized staff added a coordination message to report #${report.id}.` }, client));
        }
        return { id: created.insertId, replayed: false };
      });
      for (const notification of delivered) {
        try { events.publish(notification); }
        catch (error) { console.error('Coordination notification delivery failed after commit.', error); }
      }
      return result;
    },
    async read(id, user, body = {}) {
      const report = await access(id, user), last = positive(body.lastMessageId);
      await getDatabase().withTransaction(async client => {
        await access(report.id, user, client);
        if (!await repository.readMessage(report.id, last, client)) throw new ValidationError('Message does not belong to this report.');
        await repository.markRead(report.id, user.id, last, client);
      });
      return { unreadCount: await repository.unread(report.id, user.id) };
    },
    async reviewSeverity(id, user, body = {}) {
      if (user?.role !== 'barangay') throw new ForbiddenError('Only the assigned Barangay may confirm operational severity.');
      const report = await access(id, user);
      const assessment = evaluateSeverity(body.category, body.evidence, policy);
      const reason = text(body.reason, 'Assessment reason', 10), key = requestKey(body.requestKey);
      const classification = body.classification ?? null;
      if (![null, 'MINOR', 'MAJOR'].includes(classification)) throw new ValidationError('Choose Minor, Major, or review required.');
      const priority = body.priority ?? (classification === 'MINOR' ? 'Low' : classification === 'MAJOR' ? 'High' : null);
      if (!(classification === 'MINOR' ? ['Low', 'Medium'] : classification === 'MAJOR' ? ['High', 'Critical'] : [null]).includes(priority)) throw new ValidationError('Priority does not match the assessment.');
      if (classification && !assessment.evidence.safety_impact) throw new ValidationError('Describe the inspected impact before confirming severity.');
      const expected = positive(body.expectedReviewId ?? 0, true);
      const { derived, ...review } = assessment;
      const value = { ...review, classification, priority, reason, requestKey: key };
      value.requestHash = createHash('sha256').update(JSON.stringify([value, expected])).digest('hex');
      const result = await getDatabase().withTransaction(async client => {
        const current = await access(report.id, user, client);
        const prior = await repository.severityRequest(report.id, key, client);
        if (prior) {
          if (Number(prior.reviewed_by) !== Number(user.id) || prior.request_hash !== value.requestHash) throw new ConflictError('This request key belongs to another assessment.');
          return { id: prior.id, replayed: true };
        }
        const latest = (await repository.severityHistory(report.id, client))[0];
        if (Number(latest?.id || 0) !== expected) throw new ConflictError('Severity changed. Reload and review the latest assessment.');
        const saved = await repository.saveSeverity(current, user, value, client);
        await audit.writeAudit(user.id, 'severity_review', 'report', report.id, client, { review_id: saved.insertId, from: current.ai_classification, to: classification, reason });
        return { id: saved.insertId, replayed: false };
      });
      if (!result.replayed) events.publishReportsChanged();
      const severityHistory = await history(report.id);
      const latest = severityHistory[0];
      return { ...result, assessment: value.status, derived,
        severity: { classification: latest.classification, priority: latest.priority, recommendation: latest.recommendation },
        severityHistory };
    }
  };
}

module.exports = { createReportReviewService };
