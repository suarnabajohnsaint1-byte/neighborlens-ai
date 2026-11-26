const rules = require('../../domain/community/community.rules');
const { ForbiddenError, NotFoundError, ConflictError, ValidationError, PersistenceError } = require('../../domain/errors');
const { categoryOf } = require('../../domain/reports/damageCategories');

function createCommunityService({ getDatabase, repository, citizenIdentities, barangays, reports, reportImages, localEvidence, getImageStorage, media, audit, events, reportClock, persona, publications, incidents }) {
  function toIso(val, offset = 0) {
    return val ? reportClock.utc(val, offset) : null;
  }
  async function resolvePersona(postId, userId, db) {
    const existing = await repository.getPersona(postId, userId, db);
    if (existing) return existing;
    for (let attempt = 0; attempt < 10; attempt++) {
      const { displayName, avatarVariant } = persona.generate();
      try {
        await repository.createPersona(postId, userId, displayName, avatarVariant, db);
        return { display_name: displayName, avatar_variant: avatarVariant };
      } catch (err) {
        if (/ER_DUP_ENTRY|UNIQUE/i.test(err.message || '')) {
          const found = await repository.getPersona(postId, userId, db);
          if (found) return found;
          continue;
        }
        throw err;
      }
    }
    throw new PersistenceError('Anonymous identity could not be allocated. Please retry.');
  }
  async function visible(postId, user, db) {
    rules.viewer(user);
    const row = await repository.find(rules.id(postId), null, db);
    if (!row) throw new NotFoundError('Community post not found.');
    return row;
  }
  const changed = (scope, post, kind) => {
    try { events.publishCommunityChanged?.(scope, { postId: Number(post), kind }); }
    catch { console.error('Community event delivery failed.'); }
  };
  async function activeMember(user, db) {
    rules.viewer(user);
    const current = await repository.lockUser(user.id, db);
    if (!current || current.status !== 'active' || current.role !== user.role || Number(current.barangay_id || 0) !== Number(user.barangayId || 0) || Number(current.token_version) !== Number(user.tokenVersion)) throw new ForbiddenError('Your active membership changed. Sign in again.');
  }
  async function cleanup(reference) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try { await media.remove(reference); return; }
      catch { if (attempt === 1) console.error('Community derivative cleanup requires retry.', reference); }
    }
  }
  async function linked(row, db) {
    if (!row.report_id) return null;
    const membership = incidents && await incidents.ready(db || getDatabase()) ? await incidents.membership(row.report_id, db || getDatabase()) : null;
    const report = await reports.findById(membership?.canonical_report_id || row.report_id, db);
    if (!report || Number(report.barangay_id) !== Number(row.barangay_id)) return null;
    const reportCategory = categoryOf({ citizenCategory: report.submission_assessment?.citizen_category, originalAi: report.submission_assessment?.original_ai, ai_category: report.ai_category });
    return { id: Number(report.id), category: reportCategory, status: report.status, barangay: row.barangay, createdAt: toIso(report.created_at, await reportClock.offsetMinutes(db || getDatabase())) };
  }
  function serializableAuthor(row) {
    const a = rules.author(row);
    return { label: a.label, official: a.official, pseudonym: a.pseudonym, avatarVariant: a.avatarVariant };
  }
  async function dto(row, user, db) {
    const images = await repository.media(row.id, db);
    if (!row.is_official && !row.author_pseudonym) {
      const p = await resolvePersona(row.id, row.author_id, db || getDatabase());
      row.author_pseudonym = p.display_name;
      row.author_avatar_variant = p.avatar_variant;
    }
    const dbOffset = await reportClock.offsetMinutes(db || getDatabase());
    return {
      id: Number(row.id), body: row.body, author: serializableAuthor(row), barangay: row.barangay,
      canonicalDiscussionId: incidents && await incidents.ready(db || getDatabase()) ? await incidents.aliasOf(row.id, db || getDatabase()) : null,
      createdAt: toIso(row.created_at, dbOffset), updatedAt: toIso(row.updated_at, dbOffset), isOwnPost: Number(row.author_id) === Number(user.id),
      canEdit: Boolean(row.is_official) && Number(row.author_id) === Number(user.id), canDelete: Number(row.author_id) === Number(user.id),
      media: images.map(image => ({ id: Number(image.id), order: Number(image.image_order), url: `/api/community/posts/${row.id}/media/${image.id}` })),
      linkedReport: await linked(row, db),
      reactions: { total: Number(row.reaction_total), like: Number(row.like_total), heart: Number(row.heart_total), mine: await repository.mine(row.id, user.id, db) },
      commentCount: Number(row.comment_total), engagementVersion: Number(row.engagement_version)
    };
  }
  function commentDto(row, post, user, dbOffset = 0) {
    const isOfficial = Boolean(row.is_official);
    const isDeleted = Boolean(row.is_deleted || row.deleted_at);
    const officialLabel = name => name ? `Barangay ${name}`.replace('Barangay Barangay ', 'Barangay ') : 'Barangay official';
    const authorBarangay = row.author_barangay || (Number(row.author_id) === Number(user.id) && user.role === 'barangay' ? user.barangay : null);
    const pseudonym = isOfficial
      ? officialLabel(authorBarangay)
      : (row.author_pseudonym || 'Anonymous resident');
    const avatarVariant = isOfficial
      ? 0
      : (row.author_avatar_variant !== undefined && row.author_avatar_variant !== null ? Number(row.author_avatar_variant) : 0);
    let parentAuthor = null;
    if (row.parent_id) {
      if (row.parent_is_official) {
        parentAuthor = officialLabel(row.parent_author_barangay);
      } else if (row.parent_author_pseudonym) {
        parentAuthor = row.parent_author_pseudonym;
      } else if (row.parent_author_id) {
        parentAuthor = 'Anonymous resident';
      }
    }
    return {
      id: Number(row.id),
      postId: Number(row.post_id || post.id),
      parentId: row.parent_id ? Number(row.parent_id) : null,
      parentCommentId: row.parent_id ? Number(row.parent_id) : null,
      directReplyCount: Number(row.direct_reply_count || 0),
      visibleReplyCount: Number(row.visible_reply_count || 0),
      threadReplyCount: Number(row.thread_reply_count || 0),
      parentAuthor,
      body: isDeleted ? 'This comment has been deleted.' : row.body,
      isDeleted,
      createdAt: toIso(row.created_at, dbOffset),
      updatedAt: toIso(row.updated_at, dbOffset),
      author: {
        label: isOfficial ? officialLabel(authorBarangay) : 'Anonymous resident',
        official: isOfficial,
        pseudonym,
        avatarVariant
      },
      reactions: {
        total: Number(row.reaction_count || 0),
        mine: Boolean(row.user_reaction),
        type: row.user_reaction || null
      },
      canEdit: !isDeleted && Number(row.author_id) === Number(user.id),
      canDelete: !isDeleted && Number(row.author_id) === Number(user.id)
    };
  }
  async function publish(user, input, files = []) {
    if (user?.role === 'citizen') return publications.request(user, input, files);
    const scope = rules.member(user);
    const key = rules.key(input.requestKey);
    const reportId = input.reportId ? rules.id(input.reportId) : null;
    let report = null;
    if (reportId) {
      report = await reports.findById(reportId);
      if (!report) throw new NotFoundError('Report not found.');
      if (Number(report.submitted_by) !== Number(user.id) || Number(report.barangay_id) !== scope) throw new ForbiddenError('Only your own reports in this barangay can be published.');
    }
    const body = rules.text(input.body || report?.description || '', 2000);
    if (!body && !files.length && !reportId) throw new ValidationError('Add an update, a photo, or an owned report.');
    if (files.length > 3) throw new ValidationError('Attach up to three photos.');
    const uploadFiles = [...files];
    if (uploadFiles.length === 0 && reportId) {
      try {
        let found = reportImages ? await reportImages.findByReportId(reportId) : [];
        if (!found || !found.length) {
          const r = await reports.findById(reportId);
          if (r?.image_path) {
            found = String(r.image_path).split(',').filter(Boolean).map(image_path => ({ image_path, mime_type: 'image/jpeg' }));
          }
        }
        for (const item of (found || [])) {
          if (uploadFiles.length >= 3) break;
          try {
            const buffer = await media.readAttachment?.(item.image_path);
            if (buffer) uploadFiles.push({ buffer, mimetype: item.mime_type || 'image/jpeg', originalname: 'report-image.jpg' });
          } catch {}
        }
      } catch {}
    }
    const hash = media.fingerprint({ body, reportId }, uploadFiles);
    if (reportId) {
      const existingForReport = await repository.byReportId?.(reportId);
      if (existingForReport) {
        if (existingForReport.request_key === key && Number(existingForReport.author_id) === Number(user.id)) return replay(existingForReport);
        throw new ConflictError('This report has already been shared with the community.');
      }
    }
    const existing = await repository.byRequest(user.id, key);
    if (existing) return replay(existing);
    const uploaded = [];
    let retained = false;
    try {
      for (const file of uploadFiles) uploaded.push(await media.publish(file));
      const result = await getDatabase().withTransaction(async db => {
        await activeMember(user, db);
        const duplicate = await repository.byRequest(user.id, key, db);
        if (duplicate) return replay(duplicate, db);
        if (reportId) {
          const lockedReport = await reports.findById(reportId, db);
          if (!lockedReport || Number(lockedReport.submitted_by) !== Number(user.id) || Number(lockedReport.barangay_id) !== scope) throw new ForbiddenError('Only your own reports in this barangay can be published.');
          const duplicateReport = await repository.byReportId?.(reportId, db);
          if (duplicateReport) {
            if (duplicateReport.request_key === key && Number(duplicateReport.author_id) === Number(user.id)) return replay(duplicateReport, db);
            throw new ConflictError('This report has already been shared with the community.');
          }
        }
        let created;
        try {
          created = await repository.create({ scope, user: user.id, official: user.role === 'barangay', body, report: reportId, key, hash }, db);
        } catch (dbError) {
          if (/ER_DUP_ENTRY|UNIQUE/i.test(dbError.message || '')) {
            const dupKey = await repository.byRequest(user.id, key, db);
            if (dupKey) return replay(dupKey, db);
            if (reportId) {
              const dupReport = await repository.byReportId(reportId, db);
              if (dupReport) {
                if (dupReport.request_key === key && Number(dupReport.author_id) === Number(user.id)) return replay(dupReport, db);
                throw new ConflictError('This report has already been shared with the community.');
              }
            }
          }
          throw dbError;
        }
        for (const [index, reference] of uploaded.entries()) await repository.addMedia(created.insertId, reference, index + 1, db);
        await audit.writeAudit(user.id, 'community_post_created', 'community_post', created.insertId, db);
        const post = await dto(await visible(created.insertId, user, db), user, db);
        return { post, created: true };
      });
      retained = result.created;
      if (result.created) changed(scope, result.post.id, 'post_created');
      return result;
    } finally {
      if (!retained) for (const reference of uploaded) await cleanup(reference);
    }
    async function replay(row, db) {
      if (row.deleted_at || Number(row.barangay_id) !== scope || (hash && row.request_hash !== hash)) throw new ConflictError('This request key belongs to another publication.');
      return { post: await dto(await visible(row.id, user, db), user, db), created: false };
    }
  }
  async function localBarangay(user) {
    if (user.role === 'citizen') {
      const address = await citizenIdentities.findReviewedAddress(user.id);
      if (address) {
        const match = rules.addressBarangay(address, await barangays.findCatalog());
        if (match) return match;
      }
    }
    return user.barangayId ? repository.barangayFilter(user.barangayId) : null;
  }

  async function list(user, input) {
    rules.viewer(user);
    const query = rules.query(input);
    const local = query.scope === 'local';
    const filter = local ? await localBarangay(user) : (query.barangay ? await repository.barangayFilter(query.barangay) : null);
    if (query.barangay && !filter) throw new ValidationError('Choose a supported Bacolod Barangay.');
    const result = local && !filter ? { rows: [], total: 0 } : await repository.list({ ...query, barangay: filter?.id || null });
    const posts = [];
    for (const row of result.rows) posts.push(await dto(row, user));
    return {
      posts,
      barangay: filter?.name ?? (local ? null : 'all'),
      userBarangay: user.barangay,
      pagination: {
        page: query.page,
        pageSize: query.size,
        total: result.total,
        pages: Math.max(1, Math.ceil(result.total / query.size))
      }
    };
  }
  async function get(user, id) { return dto(await visible(id, user), user); }
  async function update(user, id, input, deleting = false) {
    const references = await getDatabase().withTransaction(async db => {
      await activeMember(user, db);
      await repository.lockPost(rules.id(id), db);
      const row = await visible(id, user, db);
      rules.owner(row, user);
      if (!deleting && !row.is_official) throw new ConflictError('Approved citizen publication content cannot be edited. Delete it or contact an administrator.');
      const images = deleting ? await repository.media(row.id, db) : [];
      if (deleting) await repository.remove(row.id, db);
      else await repository.edit(row.id, rules.text(input.body, 2000), db);
      await audit.writeAudit(user.id, deleting ? 'community_post_deleted' : 'community_post_edited', 'community_post', row.id, db);
      return images;
    });
    for (const image of references) await cleanup(image.storage_reference);
    changed(user.barangayId, id, deleting ? 'post_deleted' : 'post_edited');
    return deleting ? { ok: true } : { post: await get(user, id) };
  }
  async function react(user, id, input) {
    const value = rules.reaction(input.reaction);
    const post = await getDatabase().withTransaction(async db => {
      await activeMember(user, db);
      await repository.lockPost(rules.id(id), db);
      await visible(id, user, db);
      await repository.setReaction(Number(id), user.id, value, db);
      return dto(await visible(id, user, db), user, db);
    });
    changed(user.barangayId, id, 'engagement_changed');
    return { reactions: post.reactions, engagementVersion: post.engagementVersion };
  }
  async function comments(user, id, input) {
    const query = rules.commentQuery(input);
    return getDatabase().withTransaction(async db => {
      await repository.lockPost(rules.id(id), db);
      const post = await visible(id, user, db);
      if (query.parent && !await repository.commentWithDeleted(query.parent, post.id, db)) throw new NotFoundError('Comment not found in this discussion.');
      const dbOffset = await reportClock.offsetMinutes(db);
      const result = await repository.comments(post.id, query, user.id, db);
      for (const row of result.rows) {
        if (!row.is_official && !row.author_pseudonym) {
          const p = await resolvePersona(post.id, row.author_id, db);
          row.author_pseudonym = p.display_name;
          row.author_avatar_variant = p.avatar_variant;
        }
      }
      const commentMap = new Map(result.rows.map(r => [r.id, r]));
      for (const row of result.rows) {
        if (row.parent_id && !row.parent_author_pseudonym) {
          const parent = commentMap.get(row.parent_id);
          if (parent) {
            row.parent_author_pseudonym = parent.author_pseudonym;
            row.parent_is_official = parent.is_official;
          }
        }
      }
      return {
        comments: result.rows.map(row => commentDto(row, post, user, dbOffset)),
        supportsHeart: result.supportsHeart,
        engagementVersion: Number(post.engagement_version),
        pagination: {
          page: result.page,
          pageSize: query.size,
          pages: result.pages,
          total: result.total,
          rootTotal: result.rootTotal,
          childTotal: result.childTotal
        }
      };
    });
  }
  async function comment(user, id, input, commentId = null, deleting = false) {
    const incidentReady = incidents && await incidents.ready(getDatabase());
    const result = await getDatabase().withTransaction(async db => {
      if (incidentReady) await incidents.lock(db);
      await activeMember(user, db);
      await repository.lockPost(rules.id(id), db);
      const post = await visible(id, user, db);
      if (commentId) {
        const row = await repository.comment(rules.id(commentId), post.id, db);
        if (!row) throw new NotFoundError('Comment not found.');
        rules.owner(row, user);
        if (deleting) await repository.removeComment(row.id, db);
        else await repository.editComment(row.id, rules.text(input.body, 1000), db);
        await audit.writeAudit(user.id, deleting ? 'community_comment_deleted' : 'community_comment_edited', 'community_comment', row.id, db);
      } else {
        const body = rules.text(input.body, 1000), key = rules.key(input.requestKey);
        const parentId = rules.parentId(input.parentCommentId === undefined ? input.parentId : input.parentCommentId);
        if (input.parentCommentId !== undefined && input.parentId !== undefined && parentId !== rules.parentId(input.parentId)) throw new ValidationError('Conflicting reply targets.');
        const previous = await repository.commentByRequest(post.id, user.id, key, db);
        if (previous) {
          if (previous.deleted_at || previous.body !== body || Number(previous.parent_id || 0) !== Number(parentId || 0)) throw new ConflictError('This request key belongs to another comment.');
          const persona = await resolvePersona(post.id, user.id, db);
          previous.author_pseudonym = persona.display_name;
          previous.author_avatar_variant = persona.avatar_variant;
          const dbOffset = await reportClock.offsetMinutes(db);
          return { comment: commentDto(previous, post, user, dbOffset), ...await repository.commentTotals(post.id, db), engagementVersion: Number(post.engagement_version), ok: true };
        }
        const canonical = incidentReady ? await incidents.aliasOf(post.id, db) : null;
        if (canonical) throw new ConflictError(`This archived discussion is linked to community post #${canonical}. Add new comments to that incident discussion.`, { code: 'CANONICAL_DISCUSSION_REQUIRED' });
        if (parentId) {
          const parentRow = await repository.comment(parentId, post.id, db);
          if (!parentRow) throw new ValidationError('Parent comment is deleted or unavailable in this discussion.');
          const lineage = await repository.commentLineage(parentId, post.id, db);
          if (lineage.length >= 64 || new Set(lineage.map(row => row.id)).size !== lineage.length) throw new ValidationError('This thread has reached its reply depth limit.');
        }
        const persona = await resolvePersona(post.id, user.id, db);
        const created = await repository.addComment(post.id, user.id, user.role === 'barangay', body, key, parentId, db);
        await audit.writeAudit(user.id, 'community_comment_created', 'community_comment', created.insertId, db);
        await repository.bump(post.id, db);
        const row = await repository.comment(created.insertId, post.id, db);
        row.author_pseudonym = persona.display_name; row.author_avatar_variant = persona.avatar_variant;
        const current = await visible(id, user, db);
        return { ok: true, comment: commentDto(row, post, user, await reportClock.offsetMinutes(db)), ...await repository.commentTotals(post.id, db), engagementVersion: Number(current.engagement_version) };
      }
      await repository.bump(post.id, db);
      return { ok: true };
    });
    changed(user.barangayId, id, 'engagement_changed');
    return result;
  }
  async function reactComment(user, id, commentId, input = {}) {
    const result = await getDatabase().withTransaction(async db => {
      await activeMember(user, db);
      await repository.lockPost(rules.id(id), db);
      const post = await visible(id, user, db);
      const targetComment = await repository.comment(rules.id(commentId), post.id, db);
      if (!targetComment) throw new NotFoundError('Comment not found.');
      if (input.reacted !== undefined && typeof input.reacted !== 'boolean') throw new ValidationError('Invalid comment reaction.');
      if (input.reaction !== undefined && input.reacted !== undefined) throw new ValidationError('Provide only one comment reaction value.');
      const reacted = input.reaction === undefined
        ? input.reacted ?? !await repository.userCommentReaction(targetComment.id, user.id, db)
        : null;
      const value = input.reaction !== undefined ? rules.reaction(input.reaction) : (reacted ? 'like' : null);
      const supportsHeart = await repository.supportsCommentReactionTypes(db);
      if (value === 'heart' && !supportsHeart) throw new ValidationError('Heart reactions are not available for comments yet.');
      await repository.setCommentReaction(targetComment.id, user.id, value, supportsHeart, db);
      const count = await repository.commentReactionCount(targetComment.id, db);
      return { commentId: targetComment.id, reacted: Boolean(value), reaction: value, total: count };
    });
    return result;
  }
  async function image(user, id, imageId) {
    const post = await visible(id, user);
    const photos = await repository.media(post.id);
    let photo = photos.find(row => Number(row.id) === rules.id(imageId));
    if (photo) return media.read(photo.storage_reference);
    throw new NotFoundError('Community photo not found.');
  }
  async function publicReport(user, id) {
    const post = await get(user, id);
    if (!post.linkedReport) throw new NotFoundError('Published report unavailable.');
    return { report: post.linkedReport, body: post.body, media: post.media };
  }
  async function identity(user, id) {
    if (user?.role !== 'admin') throw new ForbiddenError('Only Admin may access community authorship.');
    const row = await repository.identity(rules.id(id));
    if (!row) throw new NotFoundError('Community post not found.');
    await audit.writeAudit(user.id, 'community_identity_accessed', 'community_post', Number(id));
    return { author: { id: Number(row.id), username: row.username, fullName: row.full_name } };
  }
  async function eligibleReports(user) {
    const scope = rules.member(user);
    if (user.role !== 'citizen') return { reports: [] };
    const all = await reports.findAll({ role: 'citizen', userId: user.id, barangayId: scope });
    const shared = new Set(await repository.sharedReportIds(scope));
    const pending = new Map((await publications.owned(user)).requests.map(row => [row.reportId, row]));
    const items = (all || []).filter(item => Number(item.barangay_id) === scope && !shared.has(Number(item.id)) && (!pending.has(Number(item.id)) || (pending.get(Number(item.id)).state === 'rejected' && pending.get(Number(item.id)).attempts < 3)))
      .map(item => ({ ...item, publication: pending.get(Number(item.id)) || { state: 'unshared' } }));
    return { reports: items };
  }
  return { list, get, publish, update, react, comments, comment, reactComment, image, publicReport, identity, eligibleReports };
}

module.exports = { createCommunityService };
