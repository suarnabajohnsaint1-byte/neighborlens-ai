const test = require('node:test');
const assert = require('node:assert/strict');

const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const vm = require('node:vm');

const initialLocation = { barangay: 'Barangay 1', lat: 10.678, lng: 122.946, accuracy: 15, purok: 'Purok 4', address: 'Some Street' };
const context = vm.createContext({
    window: {},
    AbortController,
    document: { getElementById: () => null, querySelector: () => null },
    detect: async ({ onDetected }) => {
        onDetected(initialLocation.barangay, initialLocation.lat, initialLocation.lng, initialLocation.accuracy, initialLocation.purok, initialLocation.address);
        return initialLocation;
    }
});
const filename = resolve(__dirname, '../../frontend/js/citizen/reportLocation.js');
vm.runInContext(readFileSync(filename, 'utf8'), context, { filename });
const createLocation = vm.runInContext('createCitizenReportLocation', context);
const location = createLocation(context.detect);

test('report location uses the live address instead of the registered address without a form input', () => {
    assert.equal(location.resolveReportLocation({ address: ' Current issue address ' }, { address: 'Registered home' }), 'Current issue address');
});

test('report location retains the existing registered-address fallback when live text is unavailable', () => {
    assert.equal(location.resolveReportLocation({ address: '' }, { address: ' Registered home ' }), 'Registered home');
    assert.equal(location.resolveReportLocation({ address: '   ' }, { address: 'Registered home' }), 'Registered home');
});

test('report location never invents an address from missing or malformed values', () => {
    assert.equal(location.resolveReportLocation(null, null), '');
    assert.equal(location.resolveReportLocation({ address: {} }, { address: 123 }), '');
});

test('report location follows the newest accepted position rather than an old input value', () => {
    const latest = location.mergeDetectedLocation({ address: 'Old issue address' }, { address: 'New issue address' });
    assert.equal(location.resolveReportLocation(latest, { address: 'Registered home' }), 'New issue address');
});

test('report location does not retain a stale live address after it is cleared', () => {
    const latest = location.mergeDetectedLocation({ address: 'Old issue address' }, { address: '' });
    assert.equal(location.resolveReportLocation(latest, null), '');
});

test('mergeDetectedLocation replaces every field with the newest position', () => {
    const previous = { lat: 10.69240, lng: 122.96614, barangay: 'Mandalagan', purok: 'Purok 13', address: 'Address A', accuracy: 15 };
    const update = { barangay: 'Handumanan', lat: 10.60650, lng: 122.96557, accuracy: 12, purok: null, address: 'Address B' };

    const result = location.mergeDetectedLocation(previous, update);

    assert.equal(result.lat, 10.60650);
    assert.equal(result.lng, 122.96557);
    assert.equal(result.barangay, 'Handumanan');
    assert.equal(result.purok, null);
    assert.equal(result.address, 'Address B');
    assert.equal(result.accuracy, 12);
});

test('mergeDetectedLocation clears a stale Purok when the new position has none', () => {
    const previous = { purok: 'Purok 13' };
    const update = { barangay: 'Handumanan', lat: 10.1, lng: 122.1, accuracy: 10, purok: null, address: '' };

    const result = location.mergeDetectedLocation(previous, update);

    assert.equal(result.purok, null);
});

test('mergeDetectedLocation does not retain a stale address when the new position has none', () => {
    const previous = { address: 'Old Address' };
    const update = { barangay: 'Handumanan', lat: 10.1, lng: 122.1, accuracy: 10, purok: null, address: '' };

    const result = location.mergeDetectedLocation(previous, update);

    assert.equal(result.address, '');
});

test('mergeDetectedLocation preserves a genuine zero accuracy reading instead of falling back to the previous value', () => {
    const previous = { accuracy: 15 };
    const update = { barangay: 'Barangay 1', lat: 10.1, lng: 122.1, accuracy: 0, purok: null, address: '' };

    const result = location.mergeDetectedLocation(previous, update);

    assert.equal(result.accuracy, 0);
});

test('reset clears the detected location so a reopened form cannot inherit the previous report position', async () => {
    await location.runAutoGeofence();
    assert.notEqual(location.getDetectedGPS(), null);

    location.reset();

    assert.equal(location.getDetectedGPS(), null);
});

test('mergeDetectedLocation starting from no previous location produces a coherent first snapshot', () => {
    const update = { barangay: 'Barangay 1', lat: 10.678, lng: 122.946, accuracy: 15, purok: 'Purok 4', address: 'Some Street' };

    const result = location.mergeDetectedLocation(null, update);

    assert.equal(result.lat, 10.678);
    assert.equal(result.lng, 122.946);
    assert.equal(result.barangay, 'Barangay 1');
    assert.equal(result.purok, 'Purok 4');
    assert.equal(result.address, 'Some Street');
    assert.equal(result.accuracy, 15);
});

test('reset prevents a pending geofence lookup from restoring a cleared location', async () => {
    let finish;
    const pendingLocation = createLocation(({ onDetected }) => new Promise(resolve => {
        finish = () => {
            onDetected(initialLocation.barangay, initialLocation.lat, initialLocation.lng, initialLocation.accuracy);
            resolve(initialLocation);
        };
    }));
    const lookup = pendingLocation.runAutoGeofence();
    pendingLocation.reset();
    finish();
    await lookup;
    assert.equal(pendingLocation.getDetectedGPS(), null);
});

test('submission does not reuse a street address from another location in the same barangay', async t => {
    const timestamp = Date.now();
    context.window.getCurrentLocation = async () => ({ lat: 10.681, lng: 122.949, accuracy: 15, timestamp });
    context.window.BacolodMap = { resolveReportArea: async () => ({ authoritative: true, feature: { properties: { name: 'Villamonte' } } }) };
    context.window.gpsFixDistance = () => 300;
    t.after(() => { delete context.window.getCurrentLocation; delete context.window.BacolodMap; delete context.window.gpsFixDistance; });
    const subject = createLocation(async () => ({ ...initialLocation, barangay: 'Villamonte', timestamp }));
    await subject.runAutoGeofence();
    const fix = await subject.submissionPosition();
    assert.equal(fix.address, 'Villamonte, Bacolod City');
    assert.equal(fix.purok, null);
});
