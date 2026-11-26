const test = require('node:test');
const assert = require('node:assert/strict');

// Setup mock browser environment before requiring frontend scripts
const storageData = new Map();
const mockLocalStorage = {
    getItem: (key) => storageData.has(key) ? storageData.get(key) : null,
    setItem: (key, val) => { storageData.set(key, String(val)); },
    removeItem: (key) => { storageData.delete(key); },
    clear: () => { storageData.clear(); }
};

const dispatchedEvents = [];
const elements = new Map();

function getOrCreateElement(id) {
    if (!elements.has(id)) {
        elements.set(id, {
            id,
            textContent: '',
            innerHTML: '',
            style: {},
            dataset: {},
            closest: () => ({ hidden: false }),
            classList: {
                remove: () => {},
                add: () => {}
            }
        });
    }
    return elements.get(id);
}

global.localStorage = mockLocalStorage;
global.sessionStorage = mockLocalStorage;
global.getSession = () => ({ id: 1, apiToken: 'test-token', role: 'admin' });
global.window = {
    ReportCard: require('../../frontend/js/shared/reportCard'),
    ReportVocabulary: require('../../shared/reportVocabulary'),
    ManilaDates: require('../../shared/manilaDates'),
    location: { hostname: '127.0.0.1' },
    matchMedia: () => ({ matches: false }),
    addEventListener: () => {},
    dispatchEvent: (evt) => {
        dispatchedEvents.push(evt.type || evt);
    },
    CustomEvent: class CustomEvent {
        constructor(name) { this.type = name; }
    }
};
global.CustomEvent = global.window.CustomEvent;
global.document = {
    getElementById: (id) => getOrCreateElement(id),
    querySelectorAll: () => [],
    querySelector: () => null
};
global.window.PortalComponents = require('../../frontend/js/shared/portalComponents');

// Load shared reports and admin logic
const reportsModule = require('../../frontend/js/shared/reports.js');
const {
    normalizeClassification,
    classificationBadge,
    filterReports,
    REPORTS_KEY
} = reportsModule;

const fs = require('node:fs');
const path = require('node:path');
const adminLogicCode = fs.readFileSync(path.join(__dirname, '../../frontend/js/admin/admin_logic.js'), 'utf8');
eval(adminLogicCode);

function resetTestState() {
    storageData.clear();
    dispatchedEvents.length = 0;
    elements.clear();
}

function setLocalReports(reports) {
    reportsModule.saveReports(reports);
}

function getLocalReports() {
    return JSON.parse(mockLocalStorage.getItem(REPORTS_KEY) || '[]');
}

test('1. MAJOR is displayed and counted correctly', () => {
    resetTestState();
    assert.equal(normalizeClassification('MAJOR'), 'MAJOR');
    const badge = classificationBadge('MAJOR');
    assert.match(badge, /MAJOR/);
    assert.match(badge, /color:var\(--accent-pink\)/);
    assert.match(badge, /font-weight:700/);

    setLocalReports([
        { id: 'R1', submittedByRole: 'citizen', status: 'pending', aiClassification: 'MAJOR' },
        { id: 'R2', submittedByRole: 'citizen', status: 'resolved', aiClassification: 'MAJOR' }
    ]);

    renderAdminStats();
    assert.equal(elements.get('statTotal').textContent, 2);
    assert.equal(elements.get('statMajor').textContent, 2);
    assert.equal(elements.get('statMinor').textContent, 0);
});

test('2. MINOR is displayed and counted correctly', () => {
    resetTestState();
    assert.equal(normalizeClassification('MINOR'), 'MINOR');
    const badge = classificationBadge('MINOR');
    assert.match(badge, /MINOR/);
    assert.match(badge, /color:var\(--accent-blue\)/);

    setLocalReports([
        { id: 'R1', submittedByRole: 'citizen', status: 'pending', aiClassification: 'MINOR' },
        { id: 'R2', submittedByRole: 'citizen', status: 'ongoing', aiClassification: 'MINOR' },
        { id: 'R3', submittedByRole: 'citizen', status: 'resolved', aiClassification: 'MINOR' }
    ]);

    renderAdminStats();
    assert.equal(elements.get('statTotal').textContent, 3);
    assert.equal(elements.get('statMajor').textContent, 0);
    assert.equal(elements.get('statMinor').textContent, 3);
});

test('AI suggestion appears in overview until Barangay classification supersedes it', () => {
    resetTestState();
    setLocalReports([
        { id: 'R1', submittedByRole: 'citizen', status: 'pending', aiClassification: null, suggestedClassification: 'MINOR' },
        { id: 'R2', submittedByRole: 'citizen', status: 'pending', aiClassification: 'MAJOR', suggestedClassification: 'MINOR' }
    ]);
    renderAdminStats();
    assert.equal(elements.get('statMinor').textContent, 1);
    assert.equal(elements.get('statMajor').textContent, 1);
    assert.equal(filterReports(getLocalReports(), { classification: 'MINOR' }).length, 1);
});

test('3. Lowercase and whitespace variations are normalized', () => {
    assert.equal(normalizeClassification('major'), 'MAJOR');
    assert.equal(normalizeClassification('  MAJOR  '), 'MAJOR');
    assert.equal(normalizeClassification('  major  '), 'MAJOR');
    assert.equal(normalizeClassification('minor'), 'MINOR');
    assert.equal(normalizeClassification('  MINOR  '), 'MINOR');
    assert.equal(normalizeClassification('  minor  '), 'MINOR');
});

test('4. Null classification is UNCLASSIFIED', () => {
    resetTestState();
    assert.equal(normalizeClassification(null), 'UNCLASSIFIED');
    const badge = classificationBadge(null);
    assert.match(badge, /UNCLASSIFIED/);
    assert.match(badge, /color:var\(--text-dim\)/);
    assert.doesNotMatch(badge, /MINOR/);
    assert.doesNotMatch(badge, /MAJOR/);
});

test('5. Undefined classification is UNCLASSIFIED', () => {
    resetTestState();
    assert.equal(normalizeClassification(undefined), 'UNCLASSIFIED');
    const badge = classificationBadge(undefined);
    assert.match(badge, /UNCLASSIFIED/);
    assert.match(badge, /color:var\(--text-dim\)/);
    assert.doesNotMatch(badge, /MINOR/);
});

test('6. Unknown classification is UNCLASSIFIED', () => {
    assert.equal(normalizeClassification(''), 'UNCLASSIFIED');
    assert.equal(normalizeClassification('   '), 'UNCLASSIFIED');
    assert.equal(normalizeClassification('CRITICAL'), 'UNCLASSIFIED');
    assert.equal(normalizeClassification('unknown_category'), 'UNCLASSIFIED');
    assert.equal(normalizeClassification(12345), 'UNCLASSIFIED');
});

test('7. Major + Minor + Unclassified counts remain internally consistent', () => {
    resetTestState();
    const reports = [
        // 4 MAJOR
        { id: 'R1', submittedByRole: 'citizen', aiClassification: 'MAJOR', status: 'pending', description: 'd1', barangay: 'B1' },
        { id: 'R2', submittedByRole: 'citizen', aiClassification: 'major', status: 'pending', description: 'd2', barangay: 'B1' },
        { id: 'R3', submittedByRole: 'citizen', aiClassification: '  MAJOR  ', status: 'pending', description: 'd3', barangay: 'B1' },
        { id: 'R4', submittedByRole: 'citizen', aiClassification: 'MAJOR', status: 'pending', description: 'd4', barangay: 'B1' },
        // 8 MINOR
        { id: 'R5', submittedByRole: 'citizen', aiClassification: 'MINOR', status: 'pending', description: 'd5', barangay: 'B1' },
        { id: 'R6', submittedByRole: 'citizen', aiClassification: 'minor', status: 'pending', description: 'd6', barangay: 'B1' },
        { id: 'R7', submittedByRole: 'citizen', aiClassification: ' MINOR ', status: 'pending', description: 'd7', barangay: 'B1' },
        { id: 'R8', submittedByRole: 'citizen', aiClassification: 'minor', status: 'pending', description: 'd8', barangay: 'B1' },
        { id: 'R9', submittedByRole: 'citizen', aiClassification: 'MINOR', status: 'pending', description: 'd9', barangay: 'B1' },
        { id: 'R10', submittedByRole: 'citizen', aiClassification: 'MINOR', status: 'pending', description: 'd10', barangay: 'B1' },
        { id: 'R11', submittedByRole: 'citizen', aiClassification: 'MINOR', status: 'pending', description: 'd11', barangay: 'B1' },
        { id: 'R12', submittedByRole: 'citizen', aiClassification: 'MINOR', status: 'pending', description: 'd12', barangay: 'B1' },
        // 7 UNCLASSIFIED
        { id: 'R13', submittedByRole: 'citizen', aiClassification: null, status: 'pending', description: 'd13', barangay: 'B1' },
        { id: 'R14', submittedByRole: 'citizen', aiClassification: undefined, status: 'pending', description: 'd14', barangay: 'B1' },
        { id: 'R15', submittedByRole: 'citizen', aiClassification: '', status: 'pending', description: 'd15', barangay: 'B1' },
        { id: 'R16', submittedByRole: 'citizen', aiClassification: '   ', status: 'pending', description: 'd16', barangay: 'B1' },
        { id: 'R17', submittedByRole: 'citizen', aiClassification: 'UNKNOWN', status: 'pending', description: 'd17', barangay: 'B1' },
        { id: 'R18', submittedByRole: 'citizen', aiClassification: null, status: 'pending', description: 'd18', barangay: 'B1' },
        { id: 'R19', submittedByRole: 'citizen', aiClassification: undefined, status: 'pending', description: 'd19', barangay: 'B1' }
    ];

    setLocalReports(reports);
    renderAdminStats();

    const total = elements.get('statTotal').textContent;
    const major = elements.get('statMajor').textContent;
    const minor = elements.get('statMinor').textContent;
    const unclassified = reports.filter(r => normalizeClassification(r.aiClassification) === 'UNCLASSIFIED').length;

    assert.equal(total, 19);
    assert.equal(major, 4);
    assert.equal(minor, 8);
    assert.equal(unclassified, 7);
    assert.equal(major + minor + unclassified, total);

    // Also check table rendering
    renderAdminReports();
    const firstPageHtml = elements.get('adminReportsBody').innerHTML;
    assert.equal((firstPageHtml.match(/<tr>/g) || []).length, 5);
    let tableHtml = firstPageHtml;
    for (let page = 1; page < 4; page++) {
        window.changeReportsPage(1);
        tableHtml += elements.get('adminReportsBody').innerHTML;
    }
    const majorRendered = (tableHtml.match(/>MAJOR<\/span>/g) || []).length;
    const minorRendered = (tableHtml.match(/>MINOR<\/span>/g) || []).length;
    const unclassifiedRendered = (tableHtml.match(/>UNCLASSIFIED<\/span>/g) || []).length;

    assert.equal(majorRendered, 4);
    assert.equal(minorRendered, 8);
    assert.equal(unclassifiedRendered, 7);
    assert.equal(majorRendered + minorRendered + unclassifiedRendered, 19);
});

test('8. Existing report receives an updated classification from backend', async () => {
    resetTestState();
    setLocalReports([{
        id: 'RPT_SRV_101',
        backendId: 101,
        submittedByRole: 'citizen',
        status: 'pending',
        aiClassification: 'MINOR'
    }]);

    global.getSession = () => ({ id: 1, apiToken: 'test-token', role: 'admin' });
    global.fetch = async () => ({
        ok: true,
        json: async () => ({
            reports: [{
                id: 101,
                status: 'pending',
                ai_classification: 'MAJOR'
            }]
        })
    });

    await reportsModule.syncReportsFromBackend();

    const updated = getLocalReports();
    assert.equal(updated.length, 1);
    assert.equal(updated[0].aiClassification, 'MAJOR');
    assert.ok(dispatchedEvents.includes('reports_updated'));
});

test('9. Missing backend classification does not erase valid existing classification', async () => {
    resetTestState();
    setLocalReports([{
        id: 'RPT_SRV_202',
        backendId: 202,
        submittedByRole: 'citizen',
        status: 'pending',
        aiClassification: 'MAJOR'
    }]);

    global.getSession = () => ({ id: 1, apiToken: 'test-token', role: 'admin' });
    global.fetch = async () => ({
        ok: true,
        json: async () => ({
            reports: [{
                id: 202,
                status: 'pending'
                // ai_classification is omitted
            }]
        })
    });

    await reportsModule.syncReportsFromBackend();

    const current = getLocalReports();
    assert.equal(current.length, 1);
    assert.equal(current[0].aiClassification, 'MAJOR', 'Valid existing classification must be preserved when backend omits the field');
});

test('10. Repeated synchronization with unchanged data does not trigger unnecessary updates', async () => {
    resetTestState();
    setLocalReports([{
        id: 'RPT_SRV_303',
        backendId: 303,
        submittedByRole: 'citizen',
        status: 'pending',
        aiClassification: 'MAJOR',
        images: ['/uploads/photo1.jpg'],
        image: '/uploads/photo1.jpg'
    }]);

    global.getSession = () => ({ id: 1, apiToken: 'test-token', role: 'admin' });
    global.fetch = async () => ({
        ok: true,
        json: async () => ({
            reports: [{
                id: 303,
                status: 'pending',
                ai_classification: 'MAJOR',
                images: ['/uploads/photo1.jpg']
            }]
        })
    });

    dispatchedEvents.length = 0;
    await reportsModule.syncReportsFromBackend();

    assert.equal(dispatchedEvents.length, 0, 'No reports_updated event should be dispatched if server data is unchanged');
});

test('11. Existing status and image synchronization still works', async () => {
    resetTestState();
    setLocalReports([{
        id: 'RPT_SRV_404',
        backendId: 404,
        submittedByRole: 'citizen',
        status: 'pending',
        aiClassification: 'MINOR',
        images: ['/uploads/old.jpg'],
        image: '/uploads/old.jpg'
    }]);

    global.getSession = () => ({ id: 1, apiToken: 'test-token', role: 'admin' });
    global.fetch = async () => ({
        ok: true,
        json: async () => ({
            reports: [{
                id: 404,
                status: 'ongoing',
                ai_classification: 'MINOR',
                images: ['/uploads/new1.jpg', '/uploads/new2.jpg']
            }]
        })
    });

    dispatchedEvents.length = 0;
    await reportsModule.syncReportsFromBackend();

    const updated = getLocalReports();
    assert.equal(updated.length, 1);
    assert.equal(updated[0].status, 'ongoing');
    assert.equal(updated[0].images.length, 2);
    assert.equal(updated[0].images[0], '/uploads/new1.jpg');
    assert.equal(updated[0].image, '/uploads/new1.jpg');
    assert.ok(dispatchedEvents.includes('reports_updated'));
});

test('12. Explicit null from backend updates classification to null and renders as UNCLASSIFIED', async () => {
    resetTestState();
    setLocalReports([{
        id: 'RPT_SRV_505',
        backendId: 505,
        submittedByRole: 'citizen',
        status: 'pending',
        aiClassification: 'MINOR'
    }]);

    global.getSession = () => ({ id: 1, apiToken: 'test-token', role: 'admin' });
    global.fetch = async () => ({
        ok: true,
        json: async () => ({
            reports: [{
                id: 505,
                status: 'pending',
                ai_classification: null
            }]
        })
    });

    await reportsModule.syncReportsFromBackend();

    const updated = getLocalReports();
    assert.equal(updated.length, 1);
    assert.equal(updated[0].aiClassification, null);
    assert.equal(normalizeClassification(updated[0].aiClassification), 'UNCLASSIFIED');
});

test('13. Classification filtering works with normalized values', () => {
    const list = [
        { id: '1', aiClassification: 'MAJOR' },
        { id: '2', aiClassification: 'major' },
        { id: '3', aiClassification: 'MINOR' },
        { id: '4', aiClassification: ' minor ' },
        { id: '5', aiClassification: null },
        { id: '6', aiClassification: undefined },
        { id: '7', aiClassification: 'UNKNOWN' }
    ];

    const majorFiltered = filterReports(list, { classification: 'MAJOR' });
    assert.equal(majorFiltered.length, 2);

    const minorFiltered = filterReports(list, { classification: 'MINOR' });
    assert.equal(minorFiltered.length, 2);

    const unclassifiedFiltered = filterReports(list, { classification: 'UNCLASSIFIED' });
    assert.equal(unclassifiedFiltered.length, 3);
});
