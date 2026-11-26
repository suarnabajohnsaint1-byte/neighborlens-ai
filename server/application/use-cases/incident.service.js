const { createHash } = require('node:crypto');
const { ForbiddenError, ValidationError, ConflictError, AppError, ErrorKind } = require('../../domain/errors');
const rules = require('../../domain/reports/incident.rules');
const { authorizeReportAccess } = require('../../domain/reports/report.rules');

const ROUTING_PERMISSION = 'report:assign-jurisdiction';
function createIncidentService({ getDatabase, repository, reports, reportService, permissions, barangays, geofence, images, community, notifications, events, audit }) {
  async function ready(db) {
    if (!await repository.ready(db)) throw new AppError('Incident and routing review requires database migration 017. Contact the installation operator.', ErrorKind.PROVIDER_UNAVAILABLE, { code: 'INCIDENT_REVIEW_NOT_READY' });
  }
  async function access(id, user, db) {
    const report = await repository.report(id, db);
    if (!report || !authorizeReportAccess(report, user).allowed) throw new ForbiddenError('Report is no longer available in your jurisdiction.');
    const current = await community.lockUser(user.id, db);
    if (!current || current.status !== 'active' || current.role !== user.role || Number(current.token_version) !== Number(user.tokenVersion) || user.role === 'barangay' && Number(current.barangay_id) !== Number(report.barangay_id)) throw new ForbiddenError('Your report access changed. Sign in again.');
    return report;
  }
  function official(user) { if (user?.role !== 'barangay') throw new ForbiddenError('Only the assigned Barangay may review duplicates or flag jurisdiction.'); }
  async function routingAdmin(user, db) {
    if (user?.role !== 'admin' || !await permissions.holdsActiveAdminPermission(user.id, ROUTING_PERMISSION, db)) throw new ForbiddenError('A designated routing administrator is required.');
  }
  async function execute(id, user, kind, input, action) {
    id = rules.identifier(id);
    await reportService.findAuthorizedReport(id, user);
    const reason = rules.reason(input.reason), key = rules.key(input.requestKey);
    const hash = createHash('sha256').update(JSON.stringify([kind, input])).digest('hex'), delivered = [], publicPosts = new Set();
    await ready(getDatabase());
    const result = await getDatabase().withTransaction(async db => {
      await repository.lock(db);
      const report = await access(id, user, db);
      if (kind === 'jurisdiction_corrected') await routingAdmin(user, db); else official(user);
      const prior = await repository.prior(id, key, db);
      if (prior) {
        if (Number(prior.actor_id) !== Number(user.id) || prior.request_hash !== hash) throw new ConflictError('This request key belongs to another review.');
        return { id: prior.id, replayed: true };
      }
      const details = await action(report, db, reason, delivered);
      if (['duplicate_confirmed', 'jurisdiction_corrected'].includes(kind)) {
        const incident = await repository.membership(report.id, db);
        const post = incident?.canonical_post_id || (await community.byReportId(report.id, db))?.id;
        if (post && await community.find(post, null, db)) publicPosts.add(Number(post));
      }
      const saved = await repository.record(id, user.id, kind, key, hash, reason, details, db);
      await audit.writeAudit(user.id, kind, 'report', id, db, { event_id: saved.insertId, ...details });
      return { id: saved.insertId, replayed: false };
    });
    delivered.forEach(value => events.publish(value));
    if (!result.replayed) { events.publishReportsChanged(); for (const postId of publicPosts) events.publishCommunityChanged?.(null, { postId, kind: 'incident_review' }); }
    return result;
  }
  async function notify(report, previous, title, delivered, db) {
    for (const user of await repository.recipients(report, previous, db)) delivered.push(await notifications.create({ userId: user.id, reportId: report.id, type: 'status_update', title, message: `Report #${report.id} has an updated incident or jurisdiction review. Open the report to see the current progress.` }, db));
  }
  async function verifyLocation(report, barangayId, evidenceIds, db) {
    if (!rules.coordinates(report)) throw new ValidationError('Verified coordinates and acceptable recorded GPS accuracy are required.');
    const evidence = await images.findByReportId(report.id, db);
    if (!Array.isArray(evidenceIds) || !evidenceIds.length || evidenceIds.length > 5 || evidenceIds.some(id => !evidence.some(image => Number(image.id) === rules.identifier(id)))) throw new ValidationError('Select supporting evidence belonging to this report.');
    const resolved = await geofence.resolveJurisdiction({ latitude: Number(report.latitude), longitude: Number(report.longitude), gpsAccuracy: Number(report.gps_accuracy) }, db);
    const target = await barangays.findById(barangayId, db);
    if (!target || Number(resolved.barangayId) !== barangayId || resolved.boundaryCheckStatus !== 'inside_service_area' || !target.boundary_source || !target.boundary_version) throw new ValidationError('The selected Barangay must match a unique verified boundary with a recorded source and version. Unresolved or conflicting boundaries require operator review.');
    return { target, evidence: { imageIds: evidenceIds.map(Number), latitude: report.latitude, longitude: report.longitude, gpsAccuracy: report.gps_accuracy, boundarySource: target.boundary_source, boundaryVersion: target.boundary_version, boundaryHash: createHash('sha256').update(typeof target.boundary_geojson === 'string' ? target.boundary_geojson : JSON.stringify(target.boundary_geojson)).digest('hex') } };
  }
  return {
    async load(id, user) {
      id = rules.identifier(id); await reportService.findAuthorizedReport(id, user);
      await ready(getDatabase());
      return getDatabase().withTransaction(async db => {
        await repository.lock(db); const report = await access(id, user, db);
        const incident = await repository.membership(id, db, true), canonical = incident ? await reports.findById(incident.canonical_report_id, db) : report;
        const result = { reportId: id, originalStatus: report.status, incident: incident ? { id: incident.id, canonicalReportId: incident.canonical_report_id, status: canonical.status, version: incident.version, discussionPostId: incident.canonical_post_id } : null };
        if (user.role === 'citizen') return result;
        const canAssign = user.role === 'admin' && await permissions.holdsActiveAdminPermission(user.id, ROUTING_PERMISSION, db);
        const members = canAssign && incident ? await Promise.all((await repository.members(incident.id, db)).map(async member => ({ id: member.id, routingVersion: await repository.version(member.id, db), images: await images.findByReportId(member.id, db) }))) : [];
        const candidates = (await repository.candidates(report, db)).map(target => rules.candidate(report, target)).filter(Boolean);
        const history = await repository.history(id, db);
        return { ...result, routingVersion: await repository.version(id, db), canAssignJurisdiction: canAssign, members: members.map(member => ({ ...member, images: member.images.map(image => ({ id: image.id, imageOrder: image.image_order })) })), candidates: candidates.slice(0, 50), history: history.map(row => ({ ...row, details: typeof row.details === 'string' ? JSON.parse(row.details) : row.details })), barangays: user.role === 'admin' && await permissions.holdsActiveAdminPermission(user.id, ROUTING_PERMISSION, db) ? (await barangays.findAll(db)).map(row => ({ id: row.id, name: row.name })) : [] };
      });
    },
    async decide(id, user, input = {}) {
      official(user);
      const targetId = rules.identifier(input.targetReportId);
      if (!['confirmed', 'dismissed'].includes(input.decision) || targetId === Number(id)) throw new ValidationError('Choose a different report and a valid duplicate decision.');
      return execute(id, user, input.decision === 'confirmed' ? 'duplicate_confirmed' : 'duplicate_dismissed', input, async (report, db, reason, delivered) => {
        const target = await access(targetId, user, db);
        if (Number(target.barangay_id) !== Number(report.barangay_id)) throw new ForbiddenError('Duplicate reports must belong to the same assigned jurisdiction.');
        if (input.decision === 'dismissed') return { targetReportId: targetId };
        const match = rules.candidate(report, target);
        if (!match || match.kind !== 'possible_duplicate' || ['resolved', 'rejected'].includes(report.status)) throw new ValidationError('These reports cannot be confirmed as one unresolved incident. Nearby closed damage may be recurring damage.');
        const sourceIncident = await repository.membership(report.id, db, true), targetIncident = await repository.membership(targetId, db, true);
        if (Number(sourceIncident?.version || 0) !== rules.identifier(input.expectedIncidentVersion, true) || Number(targetIncident?.version || 0) !== rules.identifier(input.expectedTargetIncidentVersion, true)) throw new ConflictError('Incident membership changed. Reload both reports before confirming.');
        if (sourceIncident) throw new ConflictError('The report already belongs to an incident. Existing incident groups require a separate reviewed correction.');
        const canonical = targetIncident ? await reports.findById(targetIncident.canonical_report_id, db) : target;
        if (['resolved', 'rejected'].includes(canonical.status)) throw new ConflictError('The canonical incident is already closed. Review this as possible recurring damage.');
        const incident = targetIncident || await repository.createIncident(target, user.id, db);
        await repository.link(report.id, incident.id, db);
        const posts = await repository.posts(incident.id, db), canonicalPost = incident.canonical_post_id || posts[0]?.id;
        if (canonicalPost) {
          await repository.setCanonical(incident.id, canonicalPost, db);
          for (const post of posts) if (Number(post.id) !== Number(canonicalPost) && !await repository.aliasOf(post.id, db)) await repository.alias(post.id, canonicalPost, incident.id, db);
        } else await repository.advanceIncident(incident.id, db);
        await notify(report, report.barangay_id, 'Duplicate incident confirmed', delivered, db);
        return { targetReportId: targetId, incidentId: incident.id, canonicalReportId: incident.canonical_report_id, canonicalPostId: canonicalPost || null };
      });
    },
    async flag(id, user, input = {}) {
      official(user);
      return execute(id, user, 'jurisdiction_flagged', input, async (report, db, reason, delivered) => {
        if (await repository.version(report.id, db) !== rules.identifier(input.expectedRoutingVersion, true)) throw new ConflictError('Jurisdiction changed. Reload before flagging.');
        const imageIds = input.evidenceImageIds;
        const evidence = await images.findByReportId(report.id, db);
        if (!Array.isArray(imageIds) || !imageIds.length || imageIds.length > 5 || imageIds.some(id => !evidence.some(image => Number(image.id) === rules.identifier(id)))) throw new ValidationError('Select supporting evidence belonging to this report.');
        const recipients = await repository.routingAdministrators(ROUTING_PERMISSION, db);
        for (const recipient of recipients) delivered.push(await notifications.create({ userId: recipient.id, reportId: report.id, type: 'status_update', title: 'Jurisdiction review requested', message: `The assigned Barangay flagged routing for report #${report.id}.` }, db));
        return { barangayId: report.barangay_id, routingVersion: await repository.version(report.id, db), evidenceImageIds: imageIds.map(Number) };
      });
    },
    async assign(id, user, input = {}) {
      await routingAdmin(user, getDatabase());
      const targetId = rules.identifier(input.barangayId);
      return execute(id, user, 'jurisdiction_corrected', input, async (report, db, reason, delivered) => {
        if (await repository.version(report.id, db) !== rules.identifier(input.expectedRoutingVersion, true)) throw new ConflictError('Jurisdiction changed. Reload before correcting.');
        if (Number(report.barangay_id) === targetId) throw new ConflictError('The report is already assigned to that Barangay.');
        const incident = await repository.membership(report.id, db, true);
        if (incident && (input.applyToIncident !== true || Number(incident.version) !== rules.identifier(input.expectedIncidentVersion, true))) throw new ConflictError('Review and explicitly include every linked incident report before changing jurisdiction.');
        const members = incident ? await repository.members(incident.id, db) : [report];
        if (incident && (!Array.isArray(input.members) || input.members.length !== members.length)) throw new ValidationError('Provide the routing version and supporting evidence for every incident member.');
        const changes = [];
        for (const member of members) {
          const supplied = incident ? input.members.find(item => Number(item.reportId) === Number(member.id)) : input;
          if (!supplied || await repository.version(member.id, db) !== rules.identifier(supplied.expectedRoutingVersion, true)) throw new ConflictError('A linked report changed. Reload all incident members.');
          const verified = await verifyLocation(member, targetId, supplied.evidenceImageIds, db);
          const previous = member.barangay_id;
          await repository.relocate(member, verified.target, db);
          const change = { reportId: member.id, previousBarangayId: previous, previousBarangay: member.barangay, newBarangayId: targetId, newBarangay: verified.target.name, previousJurisdictionSource: member.jurisdiction_source, initialCoordinates: { latitude: member.latitude, longitude: member.longitude, gpsAccuracy: member.gps_accuracy }, verifiedEvidence: verified.evidence };
          changes.push(change);
          if (Number(member.id) !== Number(report.id)) await repository.record(member.id, user.id, 'jurisdiction_corrected', rules.key(input.requestKey), createHash('sha256').update(JSON.stringify(change)).digest('hex'), reason, change, db);
          await notify({ ...member, barangay_id: targetId }, previous, 'Report jurisdiction corrected', delivered, db);
        }
        if (incident) await repository.relocateIncident(incident.id, targetId, db);
        return { changes, incidentId: incident?.id || null };
      });
    }
  };
}
module.exports = { createIncidentService, ROUTING_PERMISSION };
