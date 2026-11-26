const rules = require('../../domain/community/community.rules');
const { randomUUID } = require('node:crypto');
const { ForbiddenError, NotFoundError, ConflictError, ValidationError } = require('../../domain/errors');

function createCommunityPublicationService({ getDatabase, repository, community, barangays, reportImages, reportClock, media, audit, notifications, events, incidents, assignJurisdiction }) {
  const adminRole = user => { if (user?.role !== 'admin') throw new ForbiddenError('Only Admin may review community publication.'); };
  const emit = (name, ...args) => { try { events[name]?.(...args); } catch { console.error('Publication event delivery failed.'); } };
  const publicState = row => row ? {
    reportId: Number(row.report_id),
    state: row.state,
    version: Number(row.version),
    attempts: Number(row.attempts || 1),
    reason: row.rejection_reason || null,
    postId: row.discussion_post_id ? Number(row.discussion_post_id) : row.post_id ? Number(row.post_id) : null
  } : { state: 'unshared' };
  async function cleanup(ref) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try { await media.remove(ref); return; }
      catch { if (attempt === 1) console.error('Publication media cleanup requires retry.'); }
    }
  }
  async function activeAdmin(user, db) {
    adminRole(user);
    const admins = await repository.admins(db);
    const actor = admins.find(row => Number(row.id) === Number(user.id));
    if (!actor || actor.status !== 'active' || Number(actor.token_version) !== Number(user.tokenVersion)) throw new ForbiddenError('An active Admin session is required.');
    return admins;
  }
  async function choose(admins, db) {
    const load = new Map((await repository.workload(db)).map(row => [Number(row.assigned_admin_id), Number(row.total)]));
    return admins.filter(row => row.status === 'active').sort((a, b) => (load.get(Number(a.id)) || 0) - (load.get(Number(b.id)) || 0) || a.id - b.id)[0]?.id || null;
  }
  async function prepareAutomatic(body, files) {
    const prepared = { body: rules.text(body, 2000), key: randomUUID(), media: [] };
    try {
      prepared.hash = media.fingerprint({ body: prepared.body }, files);
      for (const file of files) prepared.media.push(await media.publishReportEvidence(file));
      return prepared;
    } catch (error) {
      await discardAutomatic(prepared);
      throw error;
    }
  }
  async function discardAutomatic(prepared) {
    for (const reference of prepared?.media || []) await cleanup(reference);
  }
  async function enqueueAutomatic(user, reportId, prepared, db) {
    const admins = await repository.admins(db);
    const member = await community.lockUser(user.id, db);
    if (!member || member.status !== 'active' || member.role !== 'citizen' || Number(member.token_version) !== Number(user.tokenVersion)) throw new ForbiddenError('Your active membership changed.');
    const report = await repository.lockReport(reportId, db);
    if (!report || Number(report.submitted_by) !== Number(user.id)) throw new ForbiddenError('Report ownership changed.');
    const admin = await choose(admins, db);
    const { insertId } = await repository.create({ report: reportId, user: user.id, scope: report.barangay_id, body: prepared.body, key: prepared.key, hash: prepared.hash, admin }, db);
    for (const [index, reference] of prepared.media.entries()) await repository.addMedia(insertId, reference, index + 1, db);
    await audit.writeAudit(user.id, admin ? `community_publication_requested_assigned_${admin}` : 'community_publication_requested_unassigned', 'community_publication', insertId, db);
    const notification = admin ? await notifications.notifyPublicationReview({ userId: admin, reportId, client: db }) : null;
    return { publication: publicState(await repository.find(reportId, db)), notification };
  }
  function announceAutomatic(result) {
    if (result?.notification) emit('publish', result.notification);
    emit('publishReportsChanged');
  }
  async function request(user, input, files = []) {
    if (user.role !== 'citizen') throw new ForbiddenError('Only citizens may request report publication.');
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ValidationError('Invalid publication request.');
    const reportId = rules.id(input.reportId), key = rules.key(input.requestKey);
    if (files.length > 3) throw new ValidationError('Attach up to three photos.');
    const initial = await repository.lockReport(reportId, getDatabase());
    if (!initial) throw new NotFoundError('Report not found.');
    if (Number(initial.submitted_by) !== Number(user.id)) throw new ForbiddenError('Only your own reports may be shared.');
    const scope = initial.barangay_id;
    const body = rules.text(input.body ?? initial.description ?? '', 2000);
    const hash = media.fingerprint({ reportId, body }, files);
    const uploaded = [];
    let retained = false;
    try {
      const sources = [...files];
      if (!sources.length && reportImages) {
        for (const photo of (await reportImages.findByReportId(reportId)).slice(0, 2)) {
          const buffer = await media.readAttachment(photo.image_path);
          sources.push({ buffer, mimetype: photo.mime_type || 'image/jpeg' });
        }
      }
      for (const file of sources) uploaded.push(await media.publish(file));
      const result = await getDatabase().withTransaction(async db => {
        const admins = await repository.admins(db);
        const member = await community.lockUser(user.id, db);
        if (!member || member.status !== 'active' || member.role !== 'citizen' || Number(member.token_version) !== Number(user.tokenVersion)) throw new ForbiddenError('Your active membership changed.');
        const report = await repository.lockReport(reportId, db);
        if (!report || Number(report.submitted_by) !== Number(user.id) || Number(report.barangay_id) !== Number(scope)) throw new ForbiddenError('Report ownership or jurisdiction changed.');
        const keyed = await repository.byKey(user.id, key, db);
        if (keyed) {
          if (Number(keyed.report_id) !== reportId || keyed.request_hash !== hash) throw new ConflictError('Request key belongs to different publication content.');
          return { publication: publicState(keyed), created: false };
        }
        if (await community.byReportId(reportId, db)) throw new ConflictError('This report has already been published.');
        const existing = await repository.find(reportId, db, true);
        if (existing && existing.state !== 'rejected') throw new ConflictError('This report already has a publication request.');
        if (existing && Number(input.version) !== Number(existing.version)) throw new ConflictError('Reload the rejected request before resubmitting.');
        if (existing && Number(existing.attempts) >= 3) throw new ConflictError('Publication resubmission limit reached. Contact an administrator.');
        const admin = await choose(admins, db);
        const values = { report: reportId, user: user.id, scope, body, key, hash, admin };
        const oldMedia = existing ? await repository.media(existing.id, db) : [];
        const id = existing ? existing.id : (await repository.create(values, db)).insertId;
        if (existing) await repository.resubmit(id, values, db);
        for (const [index, ref] of uploaded.entries()) await repository.addMedia(id, ref, index + 1, db);
        await audit.writeAudit(user.id, admin ? `community_publication_requested_assigned_${admin}` : 'community_publication_requested_unassigned', 'community_publication', id, db);
        const notification = admin ? await notifications.notifyPublicationReview({ userId: admin, reportId, client: db }) : null;
        return { publication: publicState(await repository.find(reportId, db)), created: true, oldMedia, notification };
      });
      retained = result.created;
      if (retained) emit('publishReportsChanged');
      if (result.notification) emit('publish', result.notification);
      for (const old of result.oldMedia || []) await cleanup(old.storage_reference);
      return { publication: result.publication, created: result.created };
    } finally {
      if (!retained) for (const ref of uploaded) await cleanup(ref);
    }
  }
  async function queue(user) {
    await getDatabase().withTransaction(db => activeAdmin(user, db));
    const rows = await repository.queue();
    const offset = await reportClock.offsetMinutes(getDatabase());
    return { requests: rows.map(row => ({ ...publicState(row), requestedAt: reportClock.utc(row.requested_at, offset), assignedToMe: Number(row.assigned_admin_id) === Number(user.id), assigned: Boolean(row.assigned_admin_id) })), pendingCount: rows.filter(row => row.state === 'pending_approval').length };
  }
  async function detail(user, reportId) {
    reportId = rules.id(reportId);
    return getDatabase().withTransaction(async db => {
      const admins = await activeAdmin(user, db);
      const row = await repository.find(reportId, db);
      if (!row) return { publication: { state: 'unshared' } };
      const offset = await reportClock.offsetMinutes(getDatabase(), db);
      return {
        publication: {
          ...publicState(row),
          body: row.body,
          barangayId: row.barangay_id ? Number(row.barangay_id) : null,
          reviewedBy: row.reviewed_by ? Number(row.reviewed_by) : null,
          history: (await repository.history(row.id, db)).map(item => ({ version: Number(item.version), reviewerId: Number(item.reviewer_id), state: item.decision, reason: item.reason, reviewedAt: reportClock.utc(item.reviewed_at, offset) })),
          requestedAt: row.requested_at ? reportClock.utc(row.requested_at, offset) : null,
          reviewedAt: row.reviewed_at ? reportClock.utc(row.reviewed_at, offset) : null,
          assigned: Boolean(row.assigned_admin_id),
          assignedToMe: Number(row.assigned_admin_id) === Number(user.id),
          canAssign: row.state === 'pending_approval' && !admins.some(admin => Number(admin.id) === Number(row.assigned_admin_id) && admin.status === 'active'),
          media: (await repository.media(row.id, db)).map(item => ({
            order: item.image_order,
            url: `/api/admin/community-publications/${reportId}/media/${item.image_order}`
          }))
        }
      };
    });
  }
  async function assign(user, reportId) {
    reportId = rules.id(reportId);
    const result = await getDatabase().withTransaction(async db => {
      const admins = await activeAdmin(user, db);
      const row = await repository.find(reportId, db, true);
      if (!row || row.state !== 'pending_approval') throw new ConflictError('No pending publication to assign.');
      const current = admins.find(admin => Number(admin.id) === Number(row.assigned_admin_id) && admin.status === 'active');
      if (current) throw new ConflictError('The assigned reviewer is still active.');
      const admin = await choose(admins, db);
      await repository.assign(row.id, admin, db);
      await audit.writeAudit(user.id, `community_publication_assigned_${admin}`, 'community_publication', row.id, db);
      const notification = admin ? await notifications.notifyPublicationReview({ userId: admin, reportId, client: db }) : null;
      return { publication: publicState(await repository.find(reportId, db)), notification };
    });
    emit('publishReportsChanged');
    if (result.notification) emit('publish', result.notification);
    return { publication: result.publication };
  }
  async function decide(user, reportId, input) {
    adminRole(user);
    reportId = rules.id(reportId);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ValidationError('Invalid publication decision.');
    if (!['approved', 'rejected'].includes(input.state)) throw new ValidationError('Invalid publication decision.');
    const version = rules.id(input.version);
    const reason = input.state === 'rejected' ? rules.text(input.reason, 500) : null;
    const incidentReady = incidents && await incidents.ready(getDatabase());
    if (reason && reason.length < 5) throw new ValidationError('Provide a meaningful rejection reason of at least 5 characters.');
    const result = await getDatabase().withTransaction(async db => {
      if (incidentReady) await incidents.lock(db);
      await activeAdmin(user, db);
      const report = await repository.lockReport(reportId, db);
      const incident = incidentReady ? await incidents.membership(reportId, db, true) : null;
      const row = await repository.find(reportId, db, true);
      if (!row || !report) throw new NotFoundError('Publication request not found.');
      if (Number(row.assigned_admin_id) !== Number(user.id)) throw new ForbiddenError('Only the assigned Admin may decide this request.');
      if (row.state !== 'pending_approval' || Number(row.version) !== version) throw new ConflictError('Publication changed. Reload before reviewing.');
      if (Number(row.requested_by) !== Number(report.submitted_by) || Number(row.barangay_id) !== Number(report.barangay_id)) throw new ConflictError('Report ownership or jurisdiction changed.');
      const author = await community.lockUser(row.requested_by, db);
      if (!author || author.role !== 'citizen' || author.status !== 'active') throw new ConflictError('The citizen is no longer eligible for publication.');
      let post = null;
      if (input.state === 'approved') {
        if (!row.barangay_id) throw new ValidationError('Assign the incident barangay before publishing. Publication review remains pending.');
        if (await community.byReportId(reportId, db)) throw new ConflictError('Report already published.');
        if (incident?.canonical_post_id && !await incidents.publishedPost(incident.canonical_post_id, row.barangay_id, db)) throw new ConflictError('The canonical discussion is unavailable. A reviewed incident correction is required before publication.');
        post = incident?.canonical_post_id || (await community.create({ scope: row.barangay_id, user: row.requested_by, official: false, body: row.body, report: reportId, key: `publication_${row.id}`, hash: row.request_hash }, db)).insertId;
        if (!incident?.canonical_post_id) for (const item of await repository.media(row.id, db)) await community.addMedia(post, item.storage_reference, item.image_order, db);
      }
      const saved = await repository.decide(row.id, version, input.state, user.id, reason, incident?.canonical_post_id ? null : post, db);
      if (saved.affectedRows !== 1) throw new ConflictError('Another reviewer already decided this request.');
      if (incident && post) await incidents.setCanonical(incident.id, post, db);
      await audit.writeAudit(user.id, `community_publication_${input.state}`, 'community_publication', row.id, db);
      const notification = await notifications.notifyPublicationDecision({ userId: row.requested_by, reportId, state: input.state, reason, client: db });
      return { publication: publicState(await repository.find(reportId, db)), notification, scope: row.barangay_id, post };
    });
    emit('publish', result.notification);
    emit('publishReportsChanged');
    if (result.post) emit('publishCommunityChanged', result.scope, { postId: Number(result.post), kind: 'post_created' });
    return { publication: result.publication };
  }
  async function owned(user) {
    if (user.role !== 'citizen') throw new ForbiddenError('Only citizen publication requests are available here.');
    const requests = (await repository.owned(user.id)).map(row => ({ ...publicState(row), body: row.body }));
    return { requests };
  }
  async function resolveJurisdiction(user, reportId, input) {
    await assignJurisdiction(user, reportId, input);
    return detail(user, reportId);
  }

  async function image(user, reportId, order) {
    const { publication } = await detail(user, reportId);
    if (publication.state === 'unshared') throw new NotFoundError('Publication photo not found.');
    const row = await repository.find(rules.id(reportId));
    const photo = (await repository.media(row.id)).find(item => Number(item.image_order) === rules.id(order));
    if (!photo) throw new NotFoundError('Publication photo not found.');
    return media.read(photo.storage_reference);
  }
  return { request, queue, detail, assign, decide, owned, image, resolveJurisdiction, prepareAutomatic, enqueueAutomatic, discardAutomatic, announceAutomatic };
}
module.exports = { createCommunityPublicationService };
