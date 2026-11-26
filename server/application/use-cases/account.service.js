const { ValidationError, NotFoundError, ConflictError, ForbiddenError, UnauthenticatedError } = require('../../domain/errors');
const {
  AccountStatus,
  Permission,
  normalizeStatus,
  checkOfficialUsername,
  checkOfficialPassword,
  checkAdminPassword,
  checkPasswordForRole,
  checkFullName,
  parseAccountVersion
} = require('../../domain/accounts/account.rules');

const OFFICIAL_ROLE = 'barangay';
const ADMIN_ROLE = 'admin';
const INVALID_BARANGAY = 'Choose a valid Bacolod City barangay.';
const ADMIN_TARGET_FORBIDDEN = 'Administrator accounts can only be changed by their own owner.';
const STALE_VERSION = 'This account was changed by someone else. Reload it and try again.';

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function parseId(value, label) {
  const raw = String(value ?? '').trim();
  if (!/^[1-9]\d{0,9}$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new ValidationError(`Invalid ${label}.`);
  }
  return Number(raw);
}

function requireVersion(payload) {
  const version = parseAccountVersion(payload?.version);
  if (version === null) throw new ValidationError('The current account version is required. Reload the account and try again.');
  return version;
}

function toAccountDto(row, permissions = undefined) {
  const dto = {
    id: row.id,
    username: row.username,
    role: row.role,
    fullName: row.full_name ?? null,
    barangay: row.role === ADMIN_ROLE ? null : row.barangay ?? null,
    barangayId: row.barangay_id ?? null,
    status: row.status,
    version: Number(row.account_version ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? null
  };
  if (permissions !== undefined) dto.permissions = permissions;
  return dto;
}

function assertValid(message) {
  if (message) throw new ValidationError(message);
}

function assertSingleRowChanged({ affectedRows }) {
  if (affectedRows !== 1) throw new ConflictError(STALE_VERSION);
}

function createAccountService({
  getDatabase,
  userRepository,
  userPermissionRepository,
  adminAccessRequestRepository,
  barangayRepository,
  passwordHasher,
  tokenProvider,
  auditService,
  sessionEvents
}) {
  async function resolveBarangay(payload) {
    const hasId = payload.barangayId !== undefined && payload.barangayId !== null && payload.barangayId !== '';
    const record = hasId
      ? await barangayRepository.findById(parseId(payload.barangayId, 'barangay'))
      : text(payload.barangay) ? await barangayRepository.findByName(text(payload.barangay)) : null;
    if (!record) throw new ValidationError(INVALID_BARANGAY);
    return record;
  }

  async function findManagedOfficial(id, client) {
    const account = await userRepository.findAccountById(parseId(id, 'account ID'), client);
    if (account?.role === ADMIN_ROLE) throw new ForbiddenError(ADMIN_TARGET_FORBIDDEN);
    if (!account || account.role !== OFFICIAL_ROLE) throw new NotFoundError('Barangay official account not found.');
    return account;
  }

  function endSessions(userId) {
    if (!sessionEvents?.revoke) return;
    try {
      sessionEvents.revoke(userId);
    } catch (error) {
      console.error(error);
    }
  }

  function issueSession(account) {
    const safeUser = {
      id: account.id,
      username: account.username,
      role: account.role,
      barangay: account.barangay,
      barangay_id: account.barangay_id ?? null
    };
    return { token: tokenProvider.issue({ ...safeUser, token_version: account.token_version }), user: safeUser };
  }

  class AccountService {
    async logout(user) {
      await getDatabase().withTransaction(async (tx) => {
        await userRepository.revokeSessions(user.id, tx);
        await auditService.writeAudit(user.id, 'logout', 'user', user.id, tx);
      });
      endSessions(user.id);
      return { ok: true };
    }

    async listBarangays() {
      const rows = await barangayRepository.findCatalog();
      return rows.map(row => ({ id: row.id, name: row.name, city: row.city, province: row.province, region: row.region }));
    }

    async getOwnAccount(user) {
      const account = await userRepository.findAccountById(user.id);
      if (!account) throw new UnauthenticatedError('Your session has ended. Please sign in again.');
      const permissions = account.role === ADMIN_ROLE
        ? (await userPermissionRepository.findByUserIds([account.id])).get(Number(account.id)) || []
        : [];
      return { user: toAccountDto(account, permissions) };
    }

    async updateOwnProfile(user, payload = {}) {
      for (const field of ['username', 'role', 'barangay', 'barangayId', 'status', 'permissions', 'password']) {
        if (payload[field] !== undefined) {
          throw new ForbiddenError(`You cannot change your own ${field === 'barangayId' ? 'barangay' : field} here.`);
        }
      }
      const expectedVersion = requireVersion(payload);
      const fullName = text(payload.fullName ?? payload.full_name);
      assertValid(checkFullName(fullName));

      await getDatabase().withTransaction(async (tx) => {
        assertSingleRowChanged(await userRepository.updateOwnFullName(user.id, expectedVersion, fullName || null, tx));
        await auditService.writeAudit(user.id, 'profile_update', 'user', user.id, tx);
      });
      return this.getOwnAccount(user);
    }

    async changeOwnPassword(user, payload = {}) {
      const expectedVersion = requireVersion(payload);
      const current = typeof payload.currentPassword === 'string' ? payload.currentPassword : '';
      const next = typeof payload.newPassword === 'string' ? payload.newPassword : '';
      const credentials = await userRepository.findCredentialsById(user.id);
      if (!credentials) throw new UnauthenticatedError('Your session has ended. Please sign in again.');
      if (!passwordHasher.verify(current, credentials.password_hash)) {
        throw new ValidationError('Your current password is incorrect.');
      }
      assertValid(checkPasswordForRole(credentials.role, next));
      if (current === next) throw new ValidationError('Choose a password different from your current one.');

      await getDatabase().withTransaction(async (tx) => {
        assertSingleRowChanged(await userRepository.updateOwnPassword(user.id, expectedVersion, passwordHasher.hash(next), tx));
        await auditService.writeAudit(user.id, 'password_change', 'user', user.id, tx);
      });

      endSessions(user.id);
      return issueSession(await userRepository.findSessionState(user.id));
    }

    async listAdministrators(actor) {
      const rows = await userRepository.findAccountsByRole(ADMIN_ROLE);
      const permissions = await userPermissionRepository.findByUserIds(rows.map(row => row.id));
      const canCreateAdmins = await userPermissionRepository.holdsActiveAdminPermission(actor.id, Permission.ADMIN_CREATE);
      return {
        canCreateAdmins,
        users: rows.map(row => ({
          ...toAccountDto(row, permissions.get(Number(row.id)) || []),
          isSelf: Number(row.id) === Number(actor.id)
        }))
      };
    }

    async createAdministrator(payload = {}, actor) {
      const username = text(payload.username);
      const password = typeof payload.password === 'string' ? payload.password : '';
      const fullName = text(payload.fullName ?? payload.full_name);

      const allowed = await userPermissionRepository.holdsActiveAdminPermission(actor.id, Permission.ADMIN_CREATE);
      if (!allowed) throw new ForbiddenError('You are not authorized to create administrator accounts.');

      if (username.length > 190) throw new ValidationError('Username must be at most 190 characters.');
      assertValid(checkOfficialUsername(username));
      assertValid(checkAdminPassword(password));
      assertValid(checkFullName(fullName));

      const id = await getDatabase().withTransaction(async (tx) => {
        if (!await userPermissionRepository.holdsActiveAdminPermission(actor.id, Permission.ADMIN_CREATE, tx)) {
          throw new ForbiddenError('You are not authorized to create administrator accounts.');
        }
        const { insertId } = await userRepository.create({
          username,
          passwordHash: passwordHasher.hash(password),
          role: ADMIN_ROLE,
          barangay: 'City Wide',
          fullName: fullName || null
        }, tx);
        await auditService.writeAudit(actor.id, 'admin_create', 'user', insertId, tx, { username });
        return insertId;
      });

      return { message: 'Administrator account created.', user: toAccountDto(await userRepository.findAccountById(id), []) };
    }

    async submitAdminAccessRequest(payload = {}) {
      const username = text(payload.username);
      const password = typeof payload.password === 'string' ? payload.password : '';
      const fullName = text(payload.fullName ?? payload.full_name);
      const reason = text(payload.reason);

      if (username.length > 190) throw new ValidationError('Username must be at most 190 characters.');
      assertValid(checkOfficialUsername(username));
      assertValid(checkAdminPassword(password));
      assertValid(checkFullName(fullName));
      if (reason.length > 500) throw new ValidationError('Reason must be at most 500 characters.');

      const id = await getDatabase().withTransaction(async (tx) => {
        if (await userRepository.findByUsername(username, tx)) throw new ConflictError('That username is not available.');
        if (await adminAccessRequestRepository.hasPendingForUsername(username, tx)) {
          throw new ConflictError('A request for that username is already waiting for approval.');
        }
        const { insertId } = await adminAccessRequestRepository.create({
          username,
          fullName: fullName || null,
          passwordHash: passwordHasher.hash(password),
          reason: reason || null
        }, tx);
        await auditService.writeAudit(null, 'admin_request_submit', 'admin_access_request', insertId, tx, { username });
        return insertId;
      });

      return {
        id,
        status: 'pending',
        message: 'Request submitted. An authorized administrator must approve it before you can sign in.'
      };
    }

    async listAdminAccessRequests(actor) {
      if (!await userPermissionRepository.holdsActiveAdminPermission(actor.id, Permission.ADMIN_CREATE)) {
        throw new ForbiddenError('You are not authorized to review administrator access requests.');
      }
      const rows = await adminAccessRequestRepository.findPending();
      return {
        requests: rows.map(row => ({
          id: row.id,
          username: row.username,
          fullName: row.full_name ?? null,
          reason: row.reason ?? null,
          status: row.status,
          createdAt: row.created_at
        }))
      };
    }

    async decideAdminAccessRequest(id, decision, actor) {
      const requestId = parseId(id, 'request ID');
      if (!['approve', 'reject'].includes(decision)) throw new ValidationError('Decision must be approve or reject.');

      const result = await getDatabase().withTransaction(async (tx) => {
        if (!await userPermissionRepository.holdsActiveAdminPermission(actor.id, Permission.ADMIN_CREATE, tx)) {
          throw new ForbiddenError('You are not authorized to review administrator access requests.');
        }
        const request = await adminAccessRequestRepository.findForDecision(requestId, tx);
        if (!request) throw new NotFoundError('Access request not found.');
        if (request.status !== 'pending') throw new ConflictError(`This request was already ${request.status}.`);
        const existingAccount = await userRepository.findByUsername(request.username, tx);
        if (Number(existingAccount?.id) === Number(actor.id)) {
          throw new ForbiddenError('You cannot review your own administrator access request.');
        }

        let createdUserId = null;
        if (decision === 'approve') {
          const { insertId } = await userRepository.create({
            username: request.username,
            passwordHash: request.password_hash,
            role: ADMIN_ROLE,
            barangay: 'City Wide',
            fullName: request.full_name
          }, tx);
          createdUserId = insertId;
          await auditService.writeAudit(actor.id, 'admin_create', 'user', insertId, tx, {
            username: request.username,
            access_request_id: requestId
          });
        }

        assertSingleRowChanged(await adminAccessRequestRepository.decide(requestId, {
          status: decision === 'approve' ? 'approved' : 'rejected',
          reviewerId: actor.id,
          createdUserId
        }, tx));
        await auditService.writeAudit(
          actor.id,
          decision === 'approve' ? 'admin_request_approve' : 'admin_request_reject',
          'admin_access_request',
          requestId,
          tx,
          { username: request.username }
        );
        return createdUserId;
      });

      return {
        request: await adminAccessRequestRepository.findById(requestId),
        user: result ? toAccountDto(await userRepository.findAccountById(result), []) : null
      };
    }

    async listOfficials() {
      const rows = await userRepository.findAccountsByRole(OFFICIAL_ROLE);
      return rows.map(row => toAccountDto(row));
    }

    async getOfficial(id) {
      return toAccountDto(await findManagedOfficial(id));
    }

    async createOfficial(payload = {}, actor) {
      const username = text(payload.username);
      const password = typeof payload.password === 'string' ? payload.password : '';
      const fullName = text(payload.fullName ?? payload.full_name);

      if (username.length > 190) throw new ValidationError('Username must be at most 190 characters.');
      assertValid(checkOfficialUsername(username));
      assertValid(checkOfficialPassword(password));
      assertValid(checkFullName(fullName));
      const barangay = await resolveBarangay(payload);

      const id = await getDatabase().withTransaction(async (tx) => {
        const { insertId } = await userRepository.create({
          username,
          passwordHash: passwordHasher.hash(password),
          role: OFFICIAL_ROLE,
          barangay: barangay.name,
          barangayId: barangay.id,
          fullName: fullName || null
        }, tx);
        await auditService.writeAudit(actor.id, 'official_create', 'user', insertId, tx, {
          username,
          barangay_id: barangay.id
        });
        return insertId;
      });

      const account = toAccountDto(await userRepository.findAccountById(id));
      return { message: 'Barangay official account created.', user: account, ...account };
    }

    async updateOfficial(id, payload = {}, actor) {
      const current = await findManagedOfficial(id);
      const expectedVersion = requireVersion(payload);
      const fullName = payload.fullName === undefined && payload.full_name === undefined
        ? current.full_name
        : text(payload.fullName ?? payload.full_name) || null;
      assertValid(checkFullName(fullName || ''));

      const changesBarangay = payload.barangayId !== undefined || payload.barangay !== undefined;
      const barangay = changesBarangay
        ? await resolveBarangay(payload)
        : { id: current.barangay_id, name: current.barangay };
      const reassigned = Number(barangay.id) !== Number(current.barangay_id);

      await getDatabase().withTransaction(async (tx) => {
        assertSingleRowChanged(await userRepository.updateOfficialProfile(current.id, expectedVersion, {
          fullName,
          barangayId: barangay.id,
          barangay: barangay.name,
          revokeSessions: reassigned
        }, tx));
        await auditService.writeAudit(actor.id, reassigned ? 'official_reassign' : 'official_update', 'user', current.id, tx, {
          from_barangay_id: current.barangay_id,
          to_barangay_id: barangay.id
        });
      });

      if (reassigned) endSessions(current.id);
      return { user: toAccountDto(await userRepository.findAccountById(current.id)) };
    }

    async setOfficialStatus(id, payload = {}, actor) {
      const status = normalizeStatus(payload?.status);
      if (!status) throw new ValidationError('Status must be "active" or "suspended".');
      const current = await findManagedOfficial(id);
      const expectedVersion = requireVersion(payload);
      if (current.status === status) throw new ConflictError(`Account is already ${status}.`);

      await getDatabase().withTransaction(async (tx) => {
        assertSingleRowChanged(await userRepository.updateOfficialStatus(current.id, expectedVersion, status, tx));
        await auditService.writeAudit(
          actor.id,
          status === AccountStatus.SUSPENDED ? 'official_suspend' : 'official_activate',
          'user',
          current.id,
          tx,
          { from: current.status, to: status }
        );
      });

      endSessions(current.id);
      return { user: toAccountDto(await userRepository.findAccountById(current.id)) };
    }

    async resetOfficialPassword(id, payload = {}, actor) {
      const current = await findManagedOfficial(id);
      const expectedVersion = requireVersion(payload);
      const password = typeof payload.password === 'string' ? payload.password : '';
      assertValid(checkOfficialPassword(password));

      await getDatabase().withTransaction(async (tx) => {
        assertSingleRowChanged(await userRepository.updateOfficialPassword(current.id, expectedVersion, passwordHasher.hash(password), tx));
        await auditService.writeAudit(actor.id, 'official_password_reset', 'user', current.id, tx);
      });

      endSessions(current.id);
      return { ok: true, user: toAccountDto(await userRepository.findAccountById(current.id)) };
    }
  }

  return new AccountService();
}

module.exports = { createAccountService, toAccountDto };
