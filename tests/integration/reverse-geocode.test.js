const test = require('node:test')
const assert = require('node:assert')

const ReverseGeocode = require('../../frontend/js/map/reverseGeocode.js');

test('extractPurokFromPayload extract explicit Purok from address field', () => {
    const result = ReverseGeocode.extractPurokFromPayload({ purok: '13' },)

    assert.equal(result, 'Purok 13')
})

test('extractPurokFromPayload extracts explicit Purok from display name', () => {
    const result = ReverseGeocode.extractPurokFromPayload({}, 'Mandalangan Barangay Council, Purok 13, Mandalangan, Bacolod')

    assert.equal(result, 'Purok 13')
})

test('lookup uses Photon when the proxy is rate-limited without inventing Bacolod metadata', async () => {
    const originalWindow = global.window;
    const originalFetch = global.fetch;

    global.window = {
        location: {
            hostname: '127.0.0.1'
        },
        normalizeToOfficialBarangay: () => null
    };

    global.fetch = async (url) => {
        if (String(url).includes('/api/config/reverse-geocode')) {
            return { ok: false, status: 429 };
        }
        assert.equal(new URL(url).hostname, 'photon.komoot.io');

        return {
            ok: true,
            json: async () => ({
                features: [{ properties: { street: 'Unknown Road' } }]
            })
        };
    };

    try {
        const result = await ReverseGeocode.lookup({
            latitude: 7.7600,
            longitude: 125.0000,
            provider: 'nominatim'
        });

        assert.equal(result.ok, true);
        assert.equal(result.formattedAddress, 'Unknown Road');
        assert.equal(result.barangay, '');
        assert.equal(result.city, '');
        assert.equal(result.municipality, '');
        assert.equal(result.province, '');
        assert.equal(result.country, '');
    } finally {
        global.window = originalWindow;
        global.fetch = originalFetch;
    }
});

test('lookup preserves a normalized barangay returned by the address provider', async () => {
    const originalWindow = global.window;
    const originalFetch = global.fetch;

    global.window = {
        normalizeToOfficialBarangay: () => 'Barangay 1'
    };

    global.fetch = async () => ({
        ok: true,
        json: async () => ({
            status: 'OK',
            results: [{
                formatted_address: 'Barangay 1, Bacolod City',
                address_components: [
                    { long_name: 'Barangay 1', types: ['sublocality_level_1'] }
                ]
            }]
        })
    });

    try {
        const result = await ReverseGeocode.lookup({
            latitude: 10.6780,
            longitude: 122.9460,
            provider: 'google',
            apiKey: 'fake-test-key'
        });

        assert.equal(result.ok, true);
        assert.equal(result.barangay, 'Barangay 1');
        assert.equal(result.city, 'Bacolod City');
        assert.equal(result.municipality, 'Bacolod City');
        assert.equal(result.province, 'Negros Occidental');
        assert.equal(result.country, 'Philippines');
    } finally {
        global.window = originalWindow;
        global.fetch = originalFetch;
    }
});

test('extractPurokFromPayload does not infer Purok from arbitrary roads or neighbourhoods without Purok keyword', () => {
    const payloads = [
        { address: { road: 'Lacson Street' }, display: 'Lacson Street, Bacolod City' },
        { address: { neighbourhood: 'Mansilingan Heights' }, display: 'Mansilingan Heights, Bacolod City' },
        { address: { suburb: 'Villa Angela Subdivision' }, display: 'Villa Angela Subdivision' },
        { address: { road: 'Burgos Avenue', village: 'City Heights' }, display: 'Burgos Avenue' }
    ];

    for (const { address, display } of payloads) {
        const result = ReverseGeocode.extractPurokFromPayload(address, display);
        assert.equal(result, null, `Should not infer Purok from "${display}"`);
    }
});

test('canceling an obsolete proxy lookup does not start a fallback-provider request', async t => {
    const controller = new AbortController();
    const calls = [];
    t.mock.method(global, 'fetch', (url, { signal }) => {
        calls.push(url);
        assert.equal(signal, controller.signal);
        return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    });
    const lookup = ReverseGeocode.lookup({ latitude: 10.6685, longitude: 122.9647, signal: controller.signal });
    controller.abort();
    assert.equal((await lookup).offlineFallback, true);
    assert.equal(calls.length, 1);
});
