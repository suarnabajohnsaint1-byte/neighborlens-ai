const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const presentation = require('../../frontend/js/shared/reportPresentation');

function load(file, window = {}) {
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), { window });
    return window;
}
const management = load('frontend/js/shared/reportManagement.js').ReportManagement;
const cards = load('frontend/js/community/communityCards.js', { ReportPresentation: presentation }).CommunityCards;

test('portal column subsets use the same immutable column dimensions and never supply publication controls to Barangay', () => {
    const common = management.portalColumns.barangay;
    assert.ok(common.every(id => management.portalColumns.admin.includes(id)));
    assert.equal(common.includes('publication'), false);
    assert.ok(Object.isFrozen(management.portalColumns.admin));
    for (const id of common) {
        assert.ok(management.columns[id].width >= 56);
        assert.ok(management.columns[id].label);
    }
});
test('shared normalization preserves category and independent original AI fields across API shapes', () => {
    const originalAi = { status: 'NO_DETECTION', confidence: null };
    const normalized = management.adapt({ id: 4, created_at: '2026-10-25T16:00:00Z', citizenCategory: 'Road Damage', originalAi, ai_classification: 'MINOR' });
    assert.equal(normalized.backendId, 4);
    assert.equal(normalized.citizenCategory, 'Road Damage');
    assert.equal(normalized.originalAi, originalAi);
    assert.equal(normalized.aiClassification, 'MINOR');
});
test('posts without explicit permitted actions have no misleading three-dot control', () => {
    for (const post of [{ id: 1 }, { id: 1, canEdit: false, canDelete: false }, { id: 1, canEdit: 'false', canDelete: 0 }]) assert.equal(cards.postActions(post), '');
});
test('shared post menu exposes only backend-permitted actions with accessible semantics', () => {
    const ownCitizen = cards.postActions({ id: 5, canEdit: false, canDelete: true });
    assert.match(ownCitizen, /aria-haspopup="menu"/);
    assert.match(ownCitizen, /aria-expanded="false"/);
    assert.match(ownCitizen, /role="menuitem" data-action="delete"/);
    assert.doesNotMatch(ownCitizen, /data-action="edit"/);
    assert.match(cards.postActions({ id: 6, canEdit: true, canDelete: false }), /data-action="edit"/);
});
