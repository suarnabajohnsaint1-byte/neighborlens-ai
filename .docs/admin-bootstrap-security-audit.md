# NeighborLens Admin Security Audit

Date: 19 October 2026

Branch: `citizen/detection/report/13-10-2026`

## Executive Summary

The missing-first-administrator mechanism was not confirmed: an operator-only MySQL bootstrap CLI and an audited recovery CLI already existed. Public Admin signup correctly created a pending request, not an account or session. The existing bootstrap did not meet the requested concurrency and permanent-initialization requirements.

Six reproducible defects were remediated in source. The changes reuse the account, permission, audit and password components. No new public bootstrap endpoint, authentication protocol, dependency, UI redesign, account deletion or production account was introduced.

Deployment classification: **BLOCKED / INCONCLUSIVE** until migration 013 is reviewed and applied to the intended database under operator control. The migration was executed only on temporary private MySQL instances. The configured local database and production databases were not migrated or used for state-changing tests.

## First Administrator Acceptance

The exact first-signup scenario is covered by the automated test `fresh Admin Sign Up, operator CLI bootstrap and subsequent authorized approval form one complete lifecycle` in `tests/migrations/admin-provisioning-mysql.test.js`.

Verified sequence on a second independently initialized private MySQL instance:

1. Apply all migrations and assert zero Admins and an uninitialized bootstrap record.
2. Submit the first request through the actual Admin Sign Up page in Chromium. It receives HTTP 202 with `pending`, no token and no user account.
3. Confirm that no authorized reviewer exists, the applicant cannot log in, and unauthenticated review is denied. The request remains pending without operator intervention.
4. Execute the actual `bootstrapAdmin.js` CLI entry point in a separate Node process with explicit private-database environment values. This is the entry point used by `npm run db:bootstrap-admin`; the test does not load the installation's `.env`.
5. Verify successful operator-created System Admin login, `admin:create`, one initialized bootstrap record and no automatic activation of the first public applicant.
6. Submit another request through the same Admin Sign Up page. It also remains pending and cannot log in.
7. Have the System Admin approve the first request through the real API. The first applicant can then log in as an ordinary Admin, but cannot approve the second request.
8. Have the System Admin approve the second request. Only then can that applicant log in.
9. Execute the bootstrap CLI again. It exits 1, leaves accounts unchanged and produces no additional bootstrap grant or audit. Neither invocation logs the supplied passwords.

Result: **PASS in isolated MySQL and Chromium**. Pending public signup alone does not initialize a fresh installation, by design. A missing-bootstrap business-logic bug is not confirmed because the trusted CLI exists and successfully initializes the first System Admin without approval from any existing Admin. The hardened mechanism is reused; no public bootstrap endpoint or automatic first-registrant privilege was introduced.

Latest focused verification: `npm run test:admin-security`, 31 passed, zero failed, zero skipped. Evidence: `.data/admin-provisioning/first-admin-acceptance.log`. This acceptance increment changes tests and this report only. The broader regression results below are retained from the preceding audit, not represented as rerun during this focused verification. Persistent-installation rollout still requires migration 013 and the documented operator procedure.

## Architecture Inventory

| Responsibility | Existing source and behavior |
| --- | --- |
| Public Admin signup | `frontend/admin-signup.html`, `frontend/js/auth/adminSignup.js`, `POST /api/auth/admin-access-requests`, `AccountService.submitAdminAccessRequest` |
| Staff login | `frontend/js/auth/roleLogin.js`, `frontend/js/auth/authClient.js`, `AuthService.login`, role-specific `/api/auth/admin/login` and `/api/auth/barangay/login` |
| Citizen authentication | `frontend/js/auth/auth.js`, `AuthClient`, `/api/auth/register`, `/api/auth/citizen/login`; generic `/api/auth/login` remains Citizen-only |
| Session authorization | `auth.middleware.js:requireAuth`, `AuthService.authenticateToken/resolveSession`, `sessionMatchesAccount`, persisted role/status/token version |
| Admin approval | `AccountService.listAdminAccessRequests/decideAdminAccessRequest`, `adminAccessRequest.repository.js`; `admin:create` required |
| Admin creation | `AccountService.createAdministrator`; new Admins receive no `admin:create` permission automatically |
| Account ownership | `account.service.js:findManagedOfficial` rejects Admin targets through Barangay account endpoints; profile/password self-service uses authenticated user ID |
| First Admin | `npm run db:bootstrap-admin`, `bootstrapAdmin.js`, new `adminBootstrap.service.js` and `adminInitialization.repository.js` |
| Recovery | `npm run admin:recovery`, `adminRecovery.js:readRecoveryRequest/runRecovery`; operator attribution, reason and exact target confirmation |
| Passwords | Shared bcrypt cost 12, `passwordHasher.js`, `account.rules.js`; existing login transformation and saved-account compatibility preserved |
| Audit | `audit.service.js:writeAudit`, `auditLog.repository.js`; successful account changes recorded transactionally; stale login rejected with `login_failed` |
| SSE | Single-use stream tickets plus persisted account validation; logout/session changes also use existing session events |

There is no separate `system_admin` database role. The existing System Admin capability is an active `admin` account holding `admin:create`. Ordinary Admins retain operational report access but cannot create Admins or approve access requests without that permission. HTTP account management does not allow one Admin to modify another Admin, even with `admin:create`; that permission is not a general account takeover capability.

Migrations inspected: 001 establishes users, unique usernames and audit records; 004 adds official jurisdiction, active/suspended status and token versions; 006 adds `admin:create` permissions and account versions; 007 adds access requests. Subsequent migrations through 012 add report/community behavior and do not replace this provisioning policy. Runtime database selection remains MySQL-only. SQLite remains an explicitly installed test adapter with test-only demo seeds, not a runtime fallback or public bootstrap mechanism.

## Findings

### ADM-01: Concurrent Bootstrap Accounts

Severity: Medium. Classification: provisioning race in a trusted operator workflow, not public privilege escalation.

Affected original function: `bootstrapAdmin.js:bootstrapAdmin`. The Admin count was checked outside its transaction. Different usernames in different index gaps allowed two invocations to see zero Admins and both create accounts holding `admin:create`.

Reproduction: private MySQL fixture with an intervening Citizen username; synchronize both initial count reads and invoke bootstrap with two distinct usernames. Original result: two privileged accounts. Expected: at most one bootstrap account.

Remediation: a singleton initialization row is locked with `FOR UPDATE` through the existing transaction adapter before checking eligibility. Account creation, permission grant, permanent initialization and audit insertion commit together. A failed permission write leaves no Admin, initialization marker or bootstrap audit.

Verification: private MySQL concurrent bootstrap and forced transaction-failure tests, plus shared-service unit tests. Status: fixed in source and private MySQL; installation pending migration 013.

### ADM-02: Bootstrap Reopened After Admin Loss

Severity: Medium. Classification: provisioning lifecycle defect.

Affected original function: `bootstrapAdmin.js:bootstrapAdmin`. Eligibility depended only on current Admin count, with no independent initialization state.

Reproduction: bootstrap privately, remove the last fixture account's Admin role without deleting its account, then run bootstrap under another username. Original behavior created another initial Admin. Expected: bootstrap remains closed; use trusted recovery.

Remediation: `admin_initialization` persists independently of Admin count; its owner reference becomes null on account deletion without clearing initialization. Migration 013 records existing Admin installations and installations retaining a historical `admin_bootstrap`, `admin_create` or `admin_request_approve` audit even if no Admin survives. No existing account, permission or password is overwritten by this backfill.

Verification: no-Admin-role retry is rejected; legacy-account and audit-history migration fixtures retain initialization and preserve account data. Status: fixed in source and private MySQL; installation pending migration 013.

### ADM-03: Duplicate Pending Access Requests

Severity: Medium. Classification: database integrity race.

Affected functions: `AccountService.submitAdminAccessRequest`, `AdminAccessRequestRepository.create`. Two transactions could pass the pending-username check because migration 007 had no corresponding unique constraint.

Reproduction: synchronize both pending checks for the same username. Original result: two HTTP 202 responses and two pending requests. Expected: one pending request and an HTTP 409 conflict.

Remediation: migration 013 adds a generated pending-only username key with a unique constraint. Decided requests map to null, allowing resubmission after rejection. Duplicate-key errors are translated to the existing safe conflict response. The test adapter has an equivalent partial case-insensitive unique index.

Verification: synchronized real-MySQL requests return 202/409; rejection clears the hash and permits resubmission. A legacy-duplicate fixture prevents migration completion without deleting or deciding any existing request. Status: fixed in source and private MySQL; installation pending migration 013.

### ADM-04: UTF-8 Password Truncation

Severity: Medium. Classification: credential validation inconsistency.

Affected functions: `checkOfficialPassword`, `checkPasswordForRole`, `readBootstrapCredentials`, `readRecoveryRequest`, Admin signup validation. Character limits did not enforce bcrypt's 72-byte boundary.

Reproduction: two fictional passwords sharing 72 UTF-8 bytes but differing afterward both verify against one bcrypt hash; the old staff policy accepted them. Citizen registration already enforced bytes, but password changes did not consistently do so.

Remediation: shared mutation policies reject passwords over 72 UTF-8 bytes. Bootstrap/recovery reuse the Admin policy. Admin signup mirrors the byte check with `TextEncoder`. Minimum lengths and bcrypt hashing remain unchanged. Existing logins are not silently rehashed or rewritten.

Verification: byte-boundary unit tests across all roles, bootstrap/recovery validation, real API rejection and real-browser feedback. Status: fixed for new credential writes. Historical hashes cannot reveal whether their original password exceeded the byte limit; those accounts require a user/operator password change to eliminate any historical truncation equivalence.

### ADM-05: Self-Review Rejection

Severity: Low. Classification: approval separation-of-duties defect.

Affected function: `AccountService.decideAdminAccessRequest`. An applicant independently provisioned as a permission-holding Admin under the same username could reject its own still-pending request. Self-approval already collided with the unique account username; no successful self-escalation was demonstrated.

Reproduction: submit a public request, independently provision its username and grant the review capability as an operator fixture, then reject that request as the same account. The original service allowed rejection; this was reproduced against the pre-change source with isolated dependencies.

Remediation: resolve the request username through the existing repository and refuse either decision when its account ID matches the reviewer. Other authorized reviewers retain their existing decision flow.

Verification: both own approve/reject calls return 403 and leave the request pending. Status: fixed.

### AUTH-RACE-01: Password Reset During Login

Severity: High. Classification: authentication time-of-check/time-of-use race.

Affected function: `AuthService.login`. It verified a password from one read, then issued a token using the token version from a later read. A password reset between those reads allowed the previous password to obtain a valid token with the new version.

Reproduction: perform a real private-MySQL password/token-version update immediately before the login session-state read. Original response was HTTP 200 with a token for the old password. Expected: authentication denied.

Remediation: the second account read must retain the token version used during credential verification. A changed version rejects login and records a safe failed-login audit. A reset after the second read still invalidates that earlier version through normal request authorization.

Verification: deterministic race returns 401 without a token; the replacement password subsequently authenticates. Status: fixed.

## Security Acceptance Matrix

All entries below were executed in `tests/migrations/admin-provisioning-mysql.test.js` using real private MySQL and local HTTP responses. Some scenarios are grouped in one named subtest. These are fixture verification results, not production-environment attestations.

| Scenario | Result | Evidence |
| --- | --- | --- |
| AUTH-01 Citizen at Admin login | PASS | 401 with generic invalid credentials |
| AUTH-02 Citizen at Barangay login | PASS | 401 with generic invalid credentials |
| AUTH-03 Pending Admin login | PASS | 401, no account/session issued |
| AUTH-04 Pending/forged Admin at protected API | PASS | Missing credentials and forged persisted-role mismatch return 401 |
| AUTH-05 Self-approval | PASS | Same-username reviewer gets 403 |
| AUTH-06 Unauthenticated approval | PASS | 401; Citizen and Barangay callers get 403 |
| AUTH-07 Ordinary Admin provisioning actions | PASS | Admin creation and request review get 403 |
| AUTH-08 Cross-Admin mutation | PASS | Profile, suspension and password endpoints reject Admin targets |
| AUTH-09 Cross-Barangay private report | PASS | Assigned official cannot read another barangay's report |
| AUTH-10 Concurrent bootstrap | PASS | Exactly one privileged account |
| AUTH-11 Repeated bootstrap | PASS | Refused after initialization and after loss of last Admin role |
| AUTH-12 Last System Admin disabled | PASS | HTTP self-suspension and managed-official bypass rejected; trusted recovery tested separately |
| AUTH-13 Client-controlled role | PASS | Citizen registration rejects privilege fields, creates no forged account |
| AUTH-14 Account-ID tampering | PASS | Self-profile target remains authenticated ID; protected official mutation denied |
| AUTH-15 Revoked Admin session | PASS | Existing JWT and unused stream ticket refused; recovery does not revive old JWT |
| AUTH-16 Approval replay | PASS | Concurrent 200/409/409/409, one account, hash discarded, later replay 409 |
| AUTH-17 Own request decision | PASS | Own approve and reject refused; pending state preserved |
| AUTH-18 Cross-role session reuse | PASS | Citizen/Barangay tokens get 403; forged-role, expired and tampered JWTs get 401 |

## Test Evidence

| Command | Passed | Failed | Scope |
| --- | ---: | ---: | --- |
| `npm run test:admin-security` | 31 | 0 | Six unit tests, private MySQL parent and 23 subtests, plus the complete fresh-install browser/CLI/approval lifecycle |
| `npm test` | 1008 | 0 | Existing Node unit/integration suites; fixture databases and stubbed providers where their suites install them |
| `npm run test:e2e:browser` | 20 | 0 | Existing desktop/mobile reporting flow with isolated API/data and controlled inference responses |
| `npm run test:publication` | 50 | 0 | Private MySQL/community/publication and real Chromium regressions |
| `node --test tests/migrations/registration-mysql.test.js` | 4 | 0 | Private MySQL parent plus SQL/auth and browser-harness subtests |
| Chromium cases launched by that registration harness | 42 | 0 | Desktop/mobile real OCR, identity correction/persistence, role routing, failure recovery, expiry, protected report loading and synthetic camera cases |

Latest recorded command totals: 1,155 reported passing results, zero failed, zero skipped. These combine the latest targeted run with the preceding broader regression runs; they are not a new execution of every suite. These are runner totals, not unique test cases: Node parent tests are included, and the six unit cases in `test:admin-security` also run in `npm test`. Initial reproductions and superseded harness failures are not counted as passing final runs. Initial failing logs are retained separately; the registration harness now emits its child output even when the time limit is reached rather than losing that evidence.

Blocked verification: installing migration 013 on the intended persistent database and deployment-environment acceptance. Not tested: production infrastructure, live external storage/model services and physical camera hardware, as detailed below. These were not combined with passing automated results.

`npm audit --omit=dev --json` completed successfully with zero reported production dependency advisories on this checkout. No dependency update was necessary. This registry result is not a claim that the application has no vulnerabilities.

An older Community browser test expected the explicitly removed Citizen View report control. It now asserts that the control is absent and still tests the public report endpoint for private-data leakage. The old registration harness attempted staff authentication through the Citizen form and used an ambiguous button selector; it now verifies Citizen-login denial and uses the actual role-specific forms. Registration browser cases now use the supported `complete-identity` recovery route, intercept the actual Citizen login endpoint, and distinguish retryable report-service failures from 401 session expiry. The latter must clear the session and require real login; a test initializer no longer restores the expired token on every page load. No authentication rule or application markup was changed to accommodate these tests.

Screenshots, captured against private MySQL/API:

- `.data/admin-provisioning/admin-signup-pending-mobile.png`: actual request confirmation at 390px.
- `.data/admin-provisioning/approved-admin-login-desktop.png`: actual redirect into the existing Admin shell after approval and login. Third-party assets are blocked by this security fixture; this image is not full dashboard analytics verification.

Logs are under `.data/admin-provisioning/`. The temporary MySQL directories were verified to belong to the test instances on random loopback ports before use. Concurrency barriers and password-reset hooks are test-only; successful API responses and persistence are not mocked in the new Admin provisioning tests. The registration/community suites combine actual MySQL/API and real OCR paths with explicitly controlled failure responses, OCR fixtures or inference stubs in selected cases. The main integration suites explicitly use SQLite fixtures or provider stubs where applicable. No real government ID or production credential was used.

## Migration and Operator Procedure

Migration 013 is forward-only. Do not edit already-applied migrations 001 through 012. Its initialization backfill neither creates an Admin nor changes existing accounts or permissions.

Before application, take a verified backup under the site's normal secret-handling policy and inspect pending duplicates:

```sql
SELECT username, COUNT(*) AS pending_count
FROM admin_access_requests
WHERE status = 'pending'
GROUP BY username
HAVING COUNT(*) > 1;
```

If duplicates exist, stop the migration. Have an authorized reviewer decide the obsolete requests using the existing audited request-review flow. Do not delete requests or silently approve/reject them in a migration. Retry after the duplicate query returns no rows.

During an operator-approved maintenance window, with the intended MySQL connection configured, run `npm run migrate:mysql`. This command was not run against the configured installation during this task. MySQL DDL commits independently: if the uniqueness statement fails, the initialization table may already exist while migration 013 is unrecorded. The earlier statements safely preserve an existing initialization marker on retry; inspect the error and duplicate query rather than dropping tables or resetting state.

For a genuinely fresh installation with no Admin or historical bootstrap, initialize through a trusted terminal. Enter a unique username and a new secret through an interactive credential prompt, not command-line password arguments or committed files:

```powershell
$credential = Get-Credential -UserName 'initial_admin' -Message 'First NeighborLens administrator'
$env:BOOTSTRAP_ADMIN_USERNAME = $credential.UserName
$env:BOOTSTRAP_ADMIN_PASSWORD = $credential.GetNetworkCredential().Password
try {
    npm run db:bootstrap-admin
} finally {
    Remove-Item Env:BOOTSTRAP_ADMIN_USERNAME, Env:BOOTSTRAP_ADMIN_PASSWORD -ErrorAction SilentlyContinue
    $credential = $null
}
```

The secret must have at least 12 characters, letters and numbers, and at most 72 UTF-8 bytes. The process must have access to the intended database. Environment variables are visible to sufficiently privileged host operators; use a trusted host and do not enable secret-bearing process diagnostics.

Verify initialization without reading hashes:

```sql
SELECT initialized_at, initialized_by, source FROM admin_initialization WHERE id = 1;
SELECT u.username, u.role, u.status, p.permission
FROM users u JOIN user_permissions p ON p.user_id = u.id
WHERE p.permission = 'admin:create';
SELECT action, entity_type, entity_id, created_at
FROM audit_logs WHERE action = 'admin_bootstrap' ORDER BY id DESC;
```

Log in through `admin-login.html`. Subsequent public applicants remain pending until an active permission-holding Admin reviews them through Manage Accounts. Approval creates an independent ordinary Admin account; it does not replace the reviewer, grant additional permissions or issue a public applicant a token.

Repeating bootstrap after initialization must report that initialization is complete and exit unsuccessfully without creating another account. This refusal also applies when all Admin accounts have been suspended, demoted or removed. Do not clear initialization to recover access.

For an existing Admin, the operator recovery commands remain:

```text
npm run admin:recovery -- reactivate <admin-username>
npm run admin:recovery -- reset-password <admin-username>
npm run admin:recovery -- grant-admin-create <admin-username>
```

Set `RECOVERY_OPERATOR`, a meaningful `RECOVERY_REASON` of at least ten characters, and `RECOVERY_CONFIRM` equal to the exact target username. For password reset, provide `RECOVERY_NEW_PASSWORD` from an interactive secret prompt, then remove all temporary recovery environment variables. Reactivation/password reset increment token and account versions; all recovery changes are audited, and repeated permission grants do not duplicate permissions.

If the Admin record itself was deleted or its role was changed outside supported management paths, this recovery CLI intentionally does not turn a Citizen into an Admin or recreate a deleted identity. Use the site's verified backup and an explicitly authorized DBA recovery procedure. Preserve the initialization marker and audit history. No such recovery was performed on the configured database.

Recovery from deployment problems: keep the forward schema and restore access using the existing audited CLI. Do not remove the unique constraint or initialization record as an authentication workaround. Full database restoration must use the verified pre-migration backup under operator authorization; no destructive rollback SQL is supplied.

## Changed Files

Modified:

- `frontend/js/auth/adminSignup.js`
- `package.json`
- `server/application/use-cases/account.service.js`
- `server/application/use-cases/auth.service.js`
- `server/domain/accounts/account.rules.js`
- `server/infrastructure/database/mysql/adminRecovery.js`
- `server/infrastructure/database/mysql/bootstrapAdmin.js`
- `server/infrastructure/database/mysql/mysqlAdapter.js`
- `server/infrastructure/database/sqlite/schema.sql` (test-only constraint parity)
- `server/infrastructure/repositories/adminAccessRequest.repository.js`
- `tests/migrations/community-mysql.test.js`
- `tests/migrations/registration-mysql.test.js`
- `tests/browser/registration.spec.js`

Added:

- `server/application/use-cases/adminBootstrap.service.js`
- `server/infrastructure/database/mysql/migrations/013_admin_initialization.sql`
- `server/infrastructure/repositories/adminInitialization.repository.js`
- `server/tests/admin-bootstrap.test.js`
- `tests/migrations/admin-provisioning-mysql.test.js`
- `.docs/admin-bootstrap-security-audit.md`

## Remaining Risks and Limits

- Migration 013 is not installed on the configured database. Bootstrap permanent-state protection and pending-request database uniqueness require that deployment step.
- Production TLS, proxy configuration, multi-instance rate limiting, secret rotation, backups and disaster recovery were not exercised. Current application rate limits are process-local; these tests do not establish DDoS resistance.
- Historical over-byte passwords cannot be detected from existing bcrypt hashes. Reset affected or uncertain credentials without silently changing the login protocol.
- Real Supabase persistence, production SSE infrastructure, live YOLO model quality and physical camera capture were not tested in this security task. Fixture/provider regressions must not be represented as those integrations.
- The test screenshots block third-party resources. The existing Admin signup design and markup were preserved; a complete visual redesign or third-party asset audit is outside this change.
- No unknown high-severity issue is declared fixed by inference. The deployment classification remains blocked until the required installation and environment verification is completed.

Final `git status --short`: 13 modified tracked files and six untracked source/documentation files, all listed above; nothing staged. Branch remains `citizen/detection/report/13-10-2026`. `git diff --check` exited 0 with no whitespace errors; Git emitted only line-ending normalization notices. The command outputs are saved as `.data/admin-provisioning/git-status.txt` and `.data/admin-provisioning/git-diff-check.txt`.

No commits, pushes, merges or deployments were performed.
