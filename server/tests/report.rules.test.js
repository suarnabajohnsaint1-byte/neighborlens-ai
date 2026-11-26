const test = require('node:test');
const assert = require('node:assert/strict');

const {
  STATUSES,
  ALLOWED_TRANSITIONS,
  isTerminalStatus,
  canTransition,
  checkStatusTransition,
  triageForSeverity
} = require('../domain/reports/report.rules');

test('the transition matrix matches the workflow the project implements', () => {
  assert.deepEqual(ALLOWED_TRANSITIONS.pending, ['ongoing', 'resolved', 'rejected']);
  assert.deepEqual(ALLOWED_TRANSITIONS.ongoing, ['resolved', 'rejected']);
  assert.deepEqual(ALLOWED_TRANSITIONS.resolved, []);
  assert.deepEqual(ALLOWED_TRANSITIONS.rejected, []);
});

test('every declared status appears in the matrix', () => {
  for (const status of STATUSES) {
    assert.ok(Array.isArray(ALLOWED_TRANSITIONS[status]), `${status} needs a rule`);
  }
});

test('forward transitions are allowed', () => {
  assert.equal(canTransition('pending', 'ongoing'), true);
  assert.equal(canTransition('pending', 'resolved'), true);
  assert.equal(canTransition('pending', 'rejected'), true);
  assert.equal(canTransition('ongoing', 'resolved'), true);
  assert.equal(canTransition('ongoing', 'rejected'), true);
});

test('backward transitions are refused', () => {
  assert.equal(checkStatusTransition('ongoing', 'pending').allowed, false);
  assert.equal(checkStatusTransition('ongoing', 'pending').reason, 'NOT_ALLOWED');
});

test('resolved and rejected are terminal', () => {
  assert.equal(isTerminalStatus('resolved'), true);
  assert.equal(isTerminalStatus('rejected'), true);
  assert.equal(isTerminalStatus('pending'), false);
  assert.equal(isTerminalStatus('ongoing'), false);

  for (const from of ['resolved', 'rejected']) {
    for (const to of STATUSES) {
      if (to === from) continue;
      const decision = checkStatusTransition(from, to);
      assert.equal(decision.allowed, false, `${from} -> ${to} must be refused`);
      assert.equal(decision.reason, 'TERMINAL');
    }
  }
});

test('a transition to the same status is a refused no-op', () => {
  for (const status of STATUSES) {
    const decision = checkStatusTransition(status, status);
    assert.equal(decision.allowed, false);
    assert.equal(decision.reason, 'SAME_STATUS');
  }
});

test('an unrecognised target status is refused before anything else', () => {
  const decision = checkStatusTransition('pending', 'archived');
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'UNKNOWN_STATUS');
});

test('severity maps onto the triage vocabulary the report column accepts', () => {
  assert.deepEqual(triageForSeverity('critical'), { aiClassification: 'MAJOR', aiPriority: 'Critical' });
  assert.deepEqual(triageForSeverity('high'), { aiClassification: 'MAJOR', aiPriority: 'High' });
  assert.deepEqual(triageForSeverity('medium'), { aiClassification: 'MINOR', aiPriority: 'Medium' });
  assert.deepEqual(triageForSeverity('low'), { aiClassification: 'MINOR', aiPriority: 'Low' });
  assert.deepEqual(triageForSeverity('nonsense'), {
    aiClassification: null,
    aiPriority: null
  });
});
