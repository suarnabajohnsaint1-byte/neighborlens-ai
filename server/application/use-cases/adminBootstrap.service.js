function createAdminBootstrapService({ database, initializationRepository, userRepository, userPermissionRepository, passwordHasher, auditService }) {
  return {
    async initialize(readCredentials) {
      return database.withTransaction(async tx => {
        const state = await initializationRepository.lock(tx);
        if (state.initialized_at) throw new Error('Administrator bootstrap is already initialized. Use operator recovery.');
        const existing = (await userRepository.findAccountsByRole('admin', tx))[0];
        if (existing) {
          await initializationRepository.complete(existing.id, 'legacy', tx);
          return { created: false, username: existing.username };
        }
        const { username, password } = readCredentials();
        const result = await userRepository.create({
          username,
          passwordHash: passwordHasher.hash(password),
          role: 'admin',
          barangay: 'City Wide',
          fullName: 'System Administrator'
        }, tx);
        await userPermissionRepository.grant(result.insertId, 'admin:create', null, tx);
        await initializationRepository.complete(result.insertId, 'bootstrap', tx);
        await auditService.writeAudit(null, 'admin_bootstrap', 'user', result.insertId, tx);
        return { created: true, username };
      });
    }
  };
}

module.exports = { createAdminBootstrapService };
