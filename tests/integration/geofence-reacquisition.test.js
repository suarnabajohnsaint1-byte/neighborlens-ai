const test = require('node:test');
const assert = require('node:assert/strict');

global.window = {
    addEventListener: () => { }
};

require('../../frontend/js/map/geofence.js');

function createGeoMock() {
    const state = {
        watchers: [],
        clearWatchCalls: [],
        nextWatchId: 1,
        positionQueue: []
    };

    const geolocation = {
        getCurrentPosition: (success, error) => {
            const next = state.positionQueue.shift();
            if (!next) {
                error({ code: 2, message: 'no mock position queued' });
                return;
            }
            if (next.error) {
                error(next.error);
                return;
            }
            success({ coords: next.coords, timestamp: next.timestamp ?? Date.now() });
        },
        watchPosition: (success, error) => {
            const id = state.nextWatchId++;
            state.watchers.push({ id, success, error });
            return id;
        },
        clearWatch: (id) => {
            state.clearWatchCalls.push(id);
            state.watchers = state.watchers.filter(w => w.id !== id);
        }
    };

    return { geolocation, state };
}

function installEnvironment(geolocation, canvasId) {
    const originalNavigatorDesc = Object.getOwnPropertyDescriptor(global, 'navigator');
    const originalDocument = global.document;
    const originalReverseGeocode = window.ReverseGeocode;
    const originalRenderMap = window.renderGeofenceMap;

    window.ReverseGeocode = {
        lookup: async ({ latitude }) => {
            if (Math.abs(latitude - 10.66842) < 0.001) {
                return { ok: true, barangay: 'Villamonte', purok: 'Purok 2', formattedAddress: 'Villamonte Address', displayName: 'Villamonte Address' };
            }
            return { ok: true, barangay: 'Granada', purok: null, formattedAddress: 'Granada Address', displayName: 'Granada Address' };
        }
    };
    window.renderGeofenceMap = async () => { };

    Object.defineProperty(global, 'navigator', {
        value: { geolocation },
        configurable: true,
        writable: true
    });

    const mockCanvas = { id: canvasId, style: {}, tagName: 'CANVAS', getContext: () => null };
    const address = { textContent: '' };
    const mockStatus = { innerHTML: '', querySelector: selector => selector === '.geo-address' ? address : null };
    global.document = {
        getElementById: (id) => {
            if (id === canvasId) return mockCanvas;
            if (id === 'gpsStatus') return mockStatus;
            return null;
        }
    };

    return {
        mockStatus,
        address,
        restore: () => {
            if (originalNavigatorDesc) {
                Object.defineProperty(global, 'navigator', originalNavigatorDesc);
            } else {
                delete global.navigator;
            }
            global.document = originalDocument;
            window.ReverseGeocode = originalReverseGeocode;
            window.renderGeofenceMap = originalRenderMap;
        }
    };
}

test('a timed-out reacquisition still registers a recovery watcher that can update the UI once a position arrives', async () => {
    const canvasId = 'geoCanvas-timeout-recovery';
    const { geolocation, state } = createGeoMock();
    const env = installEnvironment(geolocation, canvasId);
    const detectedCalls = [];

    state.positionQueue.push({ error: { code: 3, message: 'timeout' } });

    try {
        const result = await window.autoDetectBarangay({
            canvasId,
            onDetected: (barangay, lat, lng, accuracy, purok, address) => {
                detectedCalls.push({ barangay, lat, lng, accuracy, purok, address });
            }
        });

        assert.equal(result, null);
        assert.match(env.mockStatus.innerHTML, /timed out/i);
        assert.equal(state.watchers.length, 1, 'a recovery watcher must be registered even after a timeout');

        const recoveryWatcher = state.watchers[0];
        await recoveryWatcher.success({ timestamp: Date.now(), coords: { latitude: 10.66842, longitude: 122.96557, accuracy: 15 } });

        assert.equal(detectedCalls.length, 1, 'the recovered position must reach onDetected without a new autoDetectBarangay call');
        assert.equal(detectedCalls[0].barangay, 'Villamonte');
        assert.equal(detectedCalls[0].lat, 10.66842);
        assert.doesNotMatch(env.mockStatus.innerHTML, /timed out/i);
        assert.match(env.mockStatus.innerHTML, /Villamonte/);
        assert.equal(env.address.textContent, 'Villamonte Address');
    } finally {
        env.restore();
    }
});

test('coordinates identical to a previous generation are still accepted as a fresh acquisition after a reset', async () => {
    const canvasId = 'geoCanvas-same-coords';
    const { geolocation, state } = createGeoMock();
    const env = installEnvironment(geolocation, canvasId);
    const detectedCalls = [];
    const onDetected = (barangay, lat, lng, accuracy, purok, address) => {
        detectedCalls.push({ barangay, lat, lng, accuracy, purok, address });
    };

    state.positionQueue.push({ coords: { latitude: 10.66842, longitude: 122.96557, accuracy: 15 } });

    try {
        await window.autoDetectBarangay({ canvasId, onDetected });
        assert.equal(detectedCalls.length, 1);

        state.positionQueue.push({ error: { code: 3, message: 'timeout' } });
        await window.autoDetectBarangay({ canvasId, onDetected });

        const recoveryWatcher = state.watchers[state.watchers.length - 1];
        await recoveryWatcher.success({ timestamp: Date.now(), coords: { latitude: 10.66842, longitude: 122.96557, accuracy: 15 } });

        assert.equal(detectedCalls.length, 2, 'identical coordinates after reset must still be treated as a fresh acquisition');
        assert.equal(detectedCalls[1].lat, 10.66842);
        assert.equal(detectedCalls[1].barangay, 'Villamonte');
    } finally {
        env.restore();
    }
});

test('repeated acquire/reset cycles leave exactly one active watcher and clear every superseded one', async () => {
    const canvasId = 'geoCanvas-repeated-cycles';
    const { geolocation, state } = createGeoMock();
    const env = installEnvironment(geolocation, canvasId);
    const onDetected = () => { };

    try {
        for (let cycle = 0; cycle < 3; cycle++) {
            state.positionQueue.push({ coords: { latitude: 10.66842, longitude: 122.96557, accuracy: 15 } });
            await window.autoDetectBarangay({ canvasId, onDetected });
            assert.equal(state.watchers.length, 1, `exactly one watcher must be active after cycle ${cycle + 1}`);
        }

        assert.equal(state.clearWatchCalls.length, 2, 'each new generation after the first must clear exactly one prior watcher');
    } finally {
        env.restore();
    }
});

test('stopping location detection clears the active watcher and ignores its queued callback', async () => {
    const canvasId = 'geoCanvas-stop';
    const { geolocation, state } = createGeoMock();
    const env = installEnvironment(geolocation, canvasId);
    const positions = [];
    state.positionQueue.push({ coords: { latitude: 10.66842, longitude: 122.96557, accuracy: 15 } });
    try {
        await window.autoDetectBarangay({ canvasId, onDetected: (...position) => positions.push(position) });
        const [oldWatcher] = state.watchers;
        window.stopAutoDetectBarangay(canvasId);
        await oldWatcher.success({ timestamp: Date.now(), coords: { latitude: 10.68, longitude: 122.96, accuracy: 15 } });
        assert.deepEqual(state.clearWatchCalls, [oldWatcher.id]);
        assert.equal(state.watchers.length, 0);
        assert.equal(positions.length, 1);
    } finally {
        env.restore();
    }
});

test('Villamonte keeps its address through GPS drift and a late sample, then follows a newer clear move', async () => {
    const canvasId = 'geoCanvas-villamonte-stability';
    const { geolocation, state } = createGeoMock();
    const env = installEnvironment(geolocation, canvasId);
    const now = Date.now() - 1500;
    const at = (longitude, accuracy, timestamp) => ({ coords: { latitude: 10.66842, longitude, accuracy }, timestamp });
    const callbacks = [];
    let lookups = 0;
    window.ReverseGeocode.lookup = async ({ longitude }) => {
        lookups++;
        const barangay = longitude < 122.9658 ? 'Villamonte' : 'Granada';
        return { ok: true, barangay, formattedAddress: `${barangay} Address` };
    };
    state.positionQueue.push(at(122.96557, 18, now));
    try {
        await window.autoDetectBarangay({ canvasId, onDetected: (...fix) => callbacks.push(fix) });
        const [watcher] = state.watchers;
        await watcher.success(at(122.96590, 65, now + 600));
        assert.equal(env.address.textContent, 'Villamonte Address', 'a 36 m shift within the weaker fix’s uncertainty is drift');
        await watcher.success(at(122.97500, 10, now + 300));
        assert.equal(env.address.textContent, 'Villamonte Address', 'an older reading cannot replace the current place');
        assert.equal(lookups, 1);
        await watcher.success(at(122.97500, 10, now + 1000));
        assert.equal(env.address.textContent, 'Granada Address');
        assert.equal(callbacks.at(-1)[0], 'Granada');
        assert.equal(lookups, 2);
    } finally {
        window.stopAutoDetectBarangay(canvasId);
        env.restore();
    }
});

test('pending native reads are shared, including when one consumer requires a stricter fix', async () => {
    let complete;
    let calls = 0;
    const env = installEnvironment({ getCurrentPosition(success, error, options) {
        calls++;
        assert.deepEqual(options, { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
        complete = success;
    } }, 'gps-coalesce');
    try {
        const display = window.getCurrentLocation();
        const submission = window.getCurrentLocation({ requireAccurate: true });
        assert.equal(calls, 1);
        complete({ coords: { latitude: 10.6685, longitude: 122.9647, accuracy: 101 }, timestamp: Date.now() });
        assert.equal((await display).accuracy, 101);
        await assert.rejects(submission, /100 meters/);
        const fresh = window.getCurrentLocation({ requireAccurate: true });
        assert.equal(calls, 2);
        complete({ coords: { latitude: 10.6685, longitude: 122.9647, accuracy: 5 }, timestamp: Date.now() - 31_000 });
        await assert.rejects(fresh, /out of date/);
    } finally {
        env.restore();
    }
});
