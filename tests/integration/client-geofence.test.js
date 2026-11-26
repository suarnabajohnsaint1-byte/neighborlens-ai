const test = require('node:test');
const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const { runInNewContext } = require('node:vm');
const geometry = require('../../shared/geoContainment');
const boundaries = require('../../frontend/assets/bacolod-barangay-boundaries.json');
const manifest = require('../../frontend/assets/bacolod-boundary-version.json');

global.window = {
    addEventListener: () => { }
};

require('../../frontend/js/map/geofence.js');

// Existing verified tests 

test('Bacolod coordinate is accepted', () => {
    const result = window.validateReportGeofence(10.678, 122.946, 'Barangay 1');

    assert.equal(result.valid, true);
    assert.equal(result.isInsideBacolod, true);
});

test('Outside Bacolod coordinate is rejected', () => {
    const result = window.validateReportGeofence(
        7.7600,
        125.0000,
        null
    );

    assert.equal(result.valid, false);
    assert.equal(result.isInsideBacolod, false);
    assert.equal(result.targetBarangay, null);
});

test('reference containment finds no barangay outside Bacolod', () => {
    assert.equal(boundaries.features.some(feature => geometry.inspect(7.76, 125, feature)?.inside), false);
});

test('the shared map separates the Vista Alegre display from the service-area check', async () => {
    const source = require('../../data/geometry/bacolod-barangay-boundaries-source-v3.json');
    const original = source.features.find(feature => feature.properties.name === 'Vista Alegre');
    const overflow = { lat: 10.6273779, lng: 123.01947488369984 };
    const inland = { lat: 10.6481, lng: 123.009 };
    const requests = [];
    const browser = {
        GeoContainment: geometry,
        crypto: globalThis.crypto,
        apiRequest: async () => ({ status: 'RESOLVED', barangayId: 61, boundary: {
            name: 'Vista Alegre', geometry: original.geometry
        } })
    };
    runInNewContext(await readFile('frontend/js/map/mapConfig.js', 'utf8'), {
        window: browser, document: { baseURI: 'http://localhost/report-details.html' },
        TextEncoder, URL, AbortController, setTimeout, clearTimeout,
        async fetch(url, options) {
            requests.push({ url, options });
            return { ok: true, text: () => readFile(`frontend${url.pathname}`, 'utf8') };
        }
    });

    assert.equal(geometry.inspect(overflow.lat, overflow.lng, original).inside, true);
    const resolved = await browser.BacolodMap.resolveReportArea(inland, 5);
    assert.equal(resolved.authoritative, true);
    assert.equal(resolved.barangayId, 61);
    assert.equal(resolved.feature.geometry, original.geometry);
    assert.equal(resolved.displayFeature.properties.code, original.properties.code);
    assert.equal(geometry.inspect(inland.lat, inland.lng, resolved.displayFeature).inside, true);
    assert.equal(geometry.inspect(overflow.lat, overflow.lng, resolved.displayFeature).inside, false);
    assert.equal((await browser.BacolodMap.reportAreaAt(overflow, 5)).outsideCity, true);
    browser.apiRequest = async () => ({ status: "NO_MATCHING_POLYGON", boundaryCheckStatus: "outside_service_area" });
    const outside = await browser.BacolodMap.resolveReportArea(overflow, 5);
    assert.equal(outside.feature, null);
    assert.equal(outside.outsideCity, true);

    const city = require('../../frontend/assets/bacolod-city-boundary.json');
    const [lng, lat] = city.geometry.coordinates[0][0];
    assert.equal((await browser.BacolodMap.reportAreaAt({ lat, lng }, 5)).outsideCity, false);
    assert.equal((await browser.BacolodMap.reportAreaAt({ lat, lng }, 5)).feature, null);
    assert.equal((await browser.BacolodMap.reportAreaAt({ lat: 10.673, lng: 122.952 }, 5)).insideCity, true);

    const render = [];
    browser.L = { GeoJSON: class {
        constructor(data, options) { render.push({ data, options }); }
        addTo() { return this; }
    } };
    await browser.BacolodMap.addCityOutline({ getPane: () => ({}), createPane: () => ({ style: {} }) });
    assert.equal(render[0].data.version, manifest.display.version);
    assert.equal(JSON.stringify(render[0].data.geometry), JSON.stringify(city.geometry));
    assert.equal(render[0].options.style.dashArray, '7 4');
    assert.equal(render[0].options.smoothFactor, 0);
    assert.equal((await browser.BacolodMap.barangays()).features.length, 61);
    assert.equal(await browser.BacolodMap.boundaryVersion(), manifest.version);
    assert.equal(await browser.BacolodMap.displayBoundaryVersion(), manifest.display.version);

    assert.equal(requests.length, 5);
    assert.equal(requests[0].options.cache, 'no-cache');
    for (const entry of [manifest.city, manifest.barangays, manifest.display.city, manifest.display.barangays]) {
        const request = requests.find(({ url }) => url.pathname.endsWith(entry.file));
        assert.equal(request.url.searchParams.get('sha256'), entry.sha256);
    }
});

test('display fills reach the pinned OSM edge at reported inland and coastal gaps', () => {
    const display = require('../../frontend/assets/bacolod-display-barangays.json');
    const city = require('../../frontend/assets/bacolod-city-boundary.json');
    const reportedGaps = [
        ['Mansilingan', 10.612066233, 123.009991257],
        ['Granada', 10.636978714, 123.054851299],
        ['Felisa', 10.59631149, 122.99658476],
        ['Estefania', 10.68587311, 123.00729927],
        ['Banago', 10.71517925, 122.95195964],
        ['Singcang-Airport', 10.65304841, 122.92714909]
    ];
    assert.equal(display.features.some(feature => geometry.inspect(10.715, 122.92, feature).inside), false);
    for (const [name, lat, lng] of reportedGaps) {
        const matches = display.features.filter(feature => geometry.inspect(lat, lng, feature).inside);
        assert.deepEqual(matches.map(feature => feature.properties.name), [name]);
        assert.equal(geometry.inspect(lat, lng, city).inside, true);
    }
});

test('the estimated Esri label and a point in the Villamonte outline match different reference features', () => {
    const matches = (lat, lng) => boundaries.features.filter(feature => geometry.inspect(lat, lng, feature)?.inside)
        .map(feature => feature.properties.name);
    assert.deepEqual(matches(10.6854, 122.9873), ['Mandalagan']);
    assert.deepEqual(matches(10.6685, 122.9647), ['Villamonte']);
    // Representative point computed inside the interior ring in the reference asset.
    assert.deepEqual(matches(10.668654, 122.9711347), ['Montevista']);
});

test('reference containment rejects swapped or invalid coordinate types', () => {
    const feature = boundaries.features[0];
    for (const [lat, lng] of [[122.946, 10.678], [NaN, 122.946], ['10.678', 122.946], [undefined, undefined]]) {
        assert.equal(geometry.inspect(lat, lng, feature), null);
    }
});

// normalizeToOfficialBarangay

test('normalizeToOfficialBarangay normalizes exact official barangay names', () => {
    assert.equal(window.normalizeToOfficialBarangay('Barangay 1'), 'Barangay 1');
    assert.equal(window.normalizeToOfficialBarangay('Barangay 41'), 'Barangay 41');
    assert.equal(window.normalizeToOfficialBarangay('Mandalagan'), 'Mandalagan');
    assert.equal(window.normalizeToOfficialBarangay('Villamonte'), 'Villamonte');
});

test('normalizeToOfficialBarangay handles case insensitivity', () => {
    assert.equal(window.normalizeToOfficialBarangay('barangay 5'), 'Barangay 5');
    assert.equal(window.normalizeToOfficialBarangay('taculing'), 'Taculing');
    assert.equal(window.normalizeToOfficialBarangay('ALANGILAN'), 'Alangilan');
});

test('normalizeToOfficialBarangay resolves common named aliases and variations', () => {
    assert.equal(window.normalizeToOfficialBarangay('villa monte'), 'Villamonte');
    assert.equal(window.normalizeToOfficialBarangay('estefanya'), 'Estefania');
    assert.equal(window.normalizeToOfficialBarangay('singcang airport'), 'Singcang-Airport');
    assert.equal(window.normalizeToOfficialBarangay('singcang'), 'Singcang-Airport');
    assert.equal(window.normalizeToOfficialBarangay('sumag'), 'Sum-ag');
    assert.equal(window.normalizeToOfficialBarangay('sum-ag'), 'Sum-ag');
    assert.equal(window.normalizeToOfficialBarangay('vista alegre'), 'Vista Alegre');
    assert.equal(window.normalizeToOfficialBarangay('vista-alegre'), 'Vista Alegre');
    assert.equal(window.normalizeToOfficialBarangay('puntataytay'), 'Punta Taytay');
});

test('normalizeToOfficialBarangay resolves numbered barangay abbreviations and standalone numbers', () => {
    assert.equal(window.normalizeToOfficialBarangay('Brgy 19'), 'Barangay 19');
    assert.equal(window.normalizeToOfficialBarangay('Brgy. 4'), 'Barangay 4');
    assert.equal(window.normalizeToOfficialBarangay('Bgy 12'), 'Barangay 12');
    assert.equal(window.normalizeToOfficialBarangay('16'), 'Barangay 16');
    assert.equal(window.normalizeToOfficialBarangay('41'), 'Barangay 41');
});

test('normalizeToOfficialBarangay refuses out-of-range numbered barangays', () => {
    // Bacolod only has numbered barangays 1 through 41
    assert.equal(window.normalizeToOfficialBarangay('Barangay 0'), null);
    assert.equal(window.normalizeToOfficialBarangay('Barangay 42'), null);
    assert.equal(window.normalizeToOfficialBarangay('Barangay 99'), null);
    assert.equal(window.normalizeToOfficialBarangay('0'), null);
    assert.equal(window.normalizeToOfficialBarangay('42'), null);
});

test('normalizeToOfficialBarangay does not falsely match Purok numbers to numbered barangays', () => {
    assert.equal(window.normalizeToOfficialBarangay('Purok 5'), null);
    assert.equal(window.normalizeToOfficialBarangay('Prk 12'), null);
    assert.equal(window.normalizeToOfficialBarangay('Puk. 3'), null);
    assert.equal(window.normalizeToOfficialBarangay('Purok 5, Barangay 19'), 'Barangay 19');
});

test('normalizeToOfficialBarangay does not match a named barangay embedded inside an unrelated word', () => {
    assert.equal(window.normalizeToOfficialBarangay('Batangas City'), null);
    assert.equal(window.normalizeToOfficialBarangay('Batangas Province'), null);
});

test('normalizeToOfficialBarangay returns null for invalid, unknown, or non-string input', () => {
    assert.equal(window.normalizeToOfficialBarangay(null), null);
    assert.equal(window.normalizeToOfficialBarangay(undefined), null);
    assert.equal(window.normalizeToOfficialBarangay(''), null);
    assert.equal(window.normalizeToOfficialBarangay('   '), null);
    assert.equal(window.normalizeToOfficialBarangay(123), null);
    assert.equal(window.normalizeToOfficialBarangay('Cebu City'), null);
    assert.equal(window.normalizeToOfficialBarangay('Unknown Barangay Elsewhere'), null);
});

// validateReportGeofence

test('validateReportGeofence normalizes declared barangay inside Bacolod', () => {
    const result = window.validateReportGeofence(10.678, 122.946, 'brgy 1');
    assert.equal(result.valid, true);
    assert.equal(result.isInsideBacolod, true);
    assert.equal(result.targetBarangay, 'Barangay 1');
});

test('validateReportGeofence never claims the location is verified since only client-side detection ran', () => {
    const result = window.validateReportGeofence(10.678, 122.946, 'Barangay 1');
    assert.doesNotMatch(result.message, /verified/i);
});

test('validateReportGeofence does not invent a barangay when a declaration is omitted', () => {
    const result = window.validateReportGeofence(10.6780, 122.9460, null);
    assert.equal(result.valid, false);
    assert.equal(result.isInsideBacolod, true);
    assert.equal(result.targetBarangay, null);
});

test('validateReportGeofence rejects outside coordinate even if a Bacolod barangay is declared', () => {
    const result = window.validateReportGeofence(14.5995, 120.9842, 'Barangay 1');
    assert.equal(result.valid, false);
    assert.equal(result.isInsideBacolod, false);
    assert.equal(result.targetBarangay, 'Barangay 1');
    assert.match(result.message, /outside Bacolod City jurisdiction/);
});

test('validateReportGeofence rejects non-numeric or missing coordinates', () => {
    const result = window.validateReportGeofence(NaN, 'invalid', 'Barangay 1');
    assert.equal(result.valid, false);
    assert.equal(result.isInsideBacolod, false);
});

test('validateReportGeofence permits outside coordinate when testMode query parameter is active', () => {
    window.location = { search: '?testMode=1' };
    try {
        const result = window.validateReportGeofence(14.5995, 120.9842, 'Barangay 1');
        assert.equal(result.valid, true);
        assert.equal(result.testMode, true);
        assert.equal(result.isInsideBacolod, false);
        assert.match(result.message, /TEST MODE ACTIVE/);
    } finally {
        delete window.location;
    }
});

// removePurokFromAddress

test('removePurokFromAddress removes explicit Purok/Prk prefixes and numbers', () => {
    assert.equal(
        window.removePurokFromAddress('Purok 3, Barangay 19, Bacolod City'),
        'Barangay 19, Bacolod City'
    );
    assert.equal(
        window.removePurokFromAddress('Prk. San Jose, Mansilingan, Bacolod City'),
        'Mansilingan, Bacolod City'
    );
    assert.equal(
        window.removePurokFromAddress('Prk #12, Taculing'),
        'Taculing'
    );
    assert.equal(
        window.removePurokFromAddress('Puk. 4; Alijis'),
        'Alijis'
    );
});

test('removePurokFromAddress removes trailing Purok segments cleanly', () => {
    assert.equal(
        window.removePurokFromAddress('Barangay 2, Purok 5'),
        'Barangay 2'
    );
});

test('removePurokFromAddress leaves address without Purok intact', () => {
    const cleanAddress = 'Lacson Street, Barangay 1, Bacolod City';
    assert.equal(window.removePurokFromAddress(cleanAddress), cleanAddress);
});

test('removePurokFromAddress returns empty string for null, undefined, empty, or non-string inputs', () => {
    assert.equal(window.removePurokFromAddress(null), '');
    assert.equal(window.removePurokFromAddress(undefined), '');
    assert.equal(window.removePurokFromAddress(''), '');
    assert.equal(window.removePurokFromAddress('   '), '');
    assert.equal(window.removePurokFromAddress(12345), '');
});

// watchPosition stale-state prevention regression test

test('watchPosition updates location to Position B without retaining stale Purok or Address from Position A', async () => {
    const start = Date.now() - 1000;
    const originalNavigatorDesc = Object.getOwnPropertyDescriptor(global, 'navigator');
    const originalDocument = global.document;
    const originalReverseGeocode = window.ReverseGeocode;
    const originalRenderMap = window.renderGeofenceMap;

    let watchCallback = null;
    const detectedCalls = [];

    window.ReverseGeocode = {
        lookup: async ({ latitude, longitude }) => {
            // Position A: Mandalagan
            if (Math.abs(latitude - 10.69240) < 0.001) {
                return {
                    ok: true,
                    barangay: 'Mandalagan',
                    purok: 'Purok 13',
                    formattedAddress: 'Address A, Mandalagan',
                    displayName: 'Address A, Mandalagan'
                };
            }
            // Position B: Handumanan
            return {
                ok: true,
                barangay: 'Handumanan',
                purok: null,
                formattedAddress: 'Address B, Handumanan',
                displayName: 'Address B, Handumanan'
            };
        }
    };

    window.renderGeofenceMap = async () => { };

    Object.defineProperty(global, 'navigator', {
        value: {
            geolocation: {
                getCurrentPosition: (success) => {
                    success({
                        timestamp: start,
                        coords: {
                            latitude: 10.69240,
                            longitude: 122.96614,
                            accuracy: 15
                        }
                    });
                },
                watchPosition: (success) => {
                    watchCallback = success;
                    return 42;
                },
                clearWatch: () => { }
            }
        },
        configurable: true,
        writable: true
    });

    const mockCanvas = {
        id: 'geoCanvas',
        style: {},
        tagName: 'CANVAS',
        getContext: () => null
    };

    global.document = {
        getElementById: (id) => (id === 'geoCanvas' ? mockCanvas : null)
    };

    try {
        await window.autoDetectBarangay({
            canvasId: 'geoCanvas',
            onDetected: (barangay, lat, lng, accuracy, purok, address) => {
                detectedCalls.push({ barangay, lat, lng, accuracy, purok, address });
            }
        });

        assert.equal(detectedCalls.length, 1, 'Initial position A must trigger onDetected');
        assert.equal(detectedCalls[0].barangay, 'Mandalagan');
        assert.equal(detectedCalls[0].purok, 'Purok 13');
        assert.equal(detectedCalls[0].address, 'Address A, Mandalagan');
        assert.equal(detectedCalls[0].lat, 10.69240);
        assert.equal(detectedCalls[0].lng, 122.96614);
        assert.equal(detectedCalls[0].accuracy, 15);

        assert.ok(typeof watchCallback === 'function', 'watchPosition must have registered a callback');

        await watchCallback({ timestamp: start + 100, coords: { latitude: 10.60650, longitude: 122.96557, accuracy: 200 } });
        assert.equal(detectedCalls.length, 1, 'a poor fix must preserve the last accurate location');

        await watchCallback({
            timestamp: start + 200,
            coords: {
                latitude: 10.60650,
                longitude: 122.96557,
                accuracy: 12
            }
        });

        assert.equal(detectedCalls.length, 2, 'watchPosition update must trigger second onDetected');
        const posB = detectedCalls[1];

        // Strict assertions on Position B
        assert.equal(posB.barangay, 'Handumanan');
        assert.equal(posB.lat, 10.60650);
        assert.equal(posB.lng, 122.96557);
        assert.equal(posB.accuracy, 12);
        assert.equal(posB.purok, null, 'Must NOT reuse Purok 13 from Position A');
        assert.equal(posB.address, 'Address B, Handumanan', 'Must NOT reuse Address A from Position A');
    } finally {
        if (originalNavigatorDesc) {
            Object.defineProperty(global, 'navigator', originalNavigatorDesc);
        } else {
            delete global.navigator;
        }
        global.document = originalDocument;
        window.ReverseGeocode = originalReverseGeocode;
        window.renderGeofenceMap = originalRenderMap;
    }
});

test('a late-resolving reverse-geocode response for an earlier watchPosition tick cannot overwrite a later tick', async () => {
    const start = Date.now() - 1000;
    const originalNavigatorDesc = Object.getOwnPropertyDescriptor(global, 'navigator');
    const originalDocument = global.document;
    const originalReverseGeocode = window.ReverseGeocode;
    const originalRenderMap = window.renderGeofenceMap;

    let watchCallback = null;
    const detectedCalls = [];
    let resolveTickA;
    let resolveTickB;
    const tickALookup = new Promise(resolve => { resolveTickA = resolve; });
    const tickBLookup = new Promise(resolve => { resolveTickB = resolve; });

    window.ReverseGeocode = {
        lookup: async ({ latitude }) => {
            if (Math.abs(latitude - 10.69240) < 0.001) return tickALookup;
            if (Math.abs(latitude - 10.60650) < 0.001) return tickBLookup;
            return { ok: true, barangay: null, purok: null, formattedAddress: '', displayName: '' };
        }
    };

    window.renderGeofenceMap = async () => { };

    Object.defineProperty(global, 'navigator', {
        value: {
            geolocation: {
                getCurrentPosition: (success) => {
                    success({
                        timestamp: start,
                        coords: {
                            latitude: 10.67800,
                            longitude: 122.94600,
                            accuracy: 15
                        }
                    });
                },
                watchPosition: (success) => {
                    watchCallback = success;
                    return 99;
                },
                clearWatch: () => { }
            }
        },
        configurable: true,
        writable: true
    });

    const mockCanvas = {
        id: 'geoCanvas',
        style: {},
        tagName: 'CANVAS',
        getContext: () => null
    };

    global.document = {
        getElementById: (id) => (id === 'geoCanvas' ? mockCanvas : null)
    };

    try {
        await window.autoDetectBarangay({
            canvasId: 'geoCanvas',
            onDetected: (barangay, lat, lng, accuracy, purok, address) => {
                detectedCalls.push({ barangay, lat, lng, accuracy, purok, address });
            }
        });

        assert.ok(typeof watchCallback === 'function', 'watchPosition must have registered a callback');

        const tickAPromise = watchCallback({
            timestamp: start + 100,
            coords: { latitude: 10.69240, longitude: 122.96614, accuracy: 15 }
        });
        const tickBPromise = watchCallback({
            timestamp: start + 200,
            coords: { latitude: 10.60650, longitude: 122.96557, accuracy: 12 }
        });

        resolveTickB({
            ok: true,
            barangay: 'Handumanan',
            purok: null,
            formattedAddress: 'Address B, Handumanan',
            displayName: 'Address B, Handumanan'
        });
        await tickBPromise;

        resolveTickA({
            ok: true,
            barangay: 'Mandalagan',
            purok: 'Purok 13',
            formattedAddress: 'Address A, Mandalagan',
            displayName: 'Address A, Mandalagan'
        });
        await tickAPromise;

        assert.equal(detectedCalls.length, 2, 'the stale earlier tick must not trigger an additional onDetected call once superseded');
        const latest = detectedCalls[1];
        assert.equal(latest.barangay, 'Handumanan');
        assert.equal(latest.lat, 10.60650);
        assert.equal(latest.lng, 122.96557);
        assert.equal(latest.accuracy, 12);
        assert.equal(latest.purok, null);
        assert.equal(latest.address, 'Address B, Handumanan');
    } finally {
        if (originalNavigatorDesc) {
            Object.defineProperty(global, 'navigator', originalNavigatorDesc);
        } else {
            delete global.navigator;
        }
        global.document = originalDocument;
        window.ReverseGeocode = originalReverseGeocode;
        window.renderGeofenceMap = originalRenderMap;
    }
});

test('renderGeofenceMap updates marker popup content from Position A to Position B without retaining stale coordinates', async () => {
    const originalDocument = global.document;
    const originalWindowL = window.L;
    const originalBacolodMap = window.BacolodMap;
    const originalGlobalL = global.L;

    let mapCreationCount = 0;
    let cityOutlineCount = 0;
    let createdMarker = null;

    const mockContainer = {
        id: 'leafletTestCanvas',
        tagName: 'DIV',
        style: {},
        _leaflet_id: undefined
    };

    const mockMap = {
        getContainer: () => mockContainer,
        setView: () => mockMap,
        remove: () => {},
        invalidateSize: () => {}
    };

    const mockLeaflet = {
        LeafletMap: function LeafletMap() {
            mapCreationCount++;
            return mockMap;
        },
        tileLayer: () => ({ addTo: () => {} }),
        Marker: function Marker(pos) {
            let popupContent = '';
            let popupOpen = false;
            createdMarker = {
                currentPos: pos,
                addTo: () => createdMarker,
                bindPopup: (content) => {
                    popupContent = content;
                    return createdMarker;
                },
                openPopup: () => {
                    popupOpen = true;
                    return createdMarker;
                },
                setLatLng: (newPos) => {
                    createdMarker.currentPos = newPos;
                    return createdMarker;
                },
                setPopupContent: (newContent) => {
                    popupContent = newContent;
                    return createdMarker;
                },
                getPopup: () => ({
                    getContent: () => popupContent,
                    setContent: (c) => { popupContent = c; }
                }),
                isPopupOpen: () => popupOpen
            };
            return createdMarker;
        },
        Circle: function Circle(pos) {
            const circleObj = {
                setLatLng: () => circleObj,
                setRadius: () => circleObj,
                addTo: () => circleObj,
                bindTooltip: () => circleObj
            };
            return circleObj;
        },
        polygon: () => {
            const polyObj = {
                setLatLngs: () => polyObj,
                addTo: () => polyObj,
                bindTooltip: () => polyObj
            };
            return polyObj;
        }
    };

    window.L = mockLeaflet;
    window.BacolodMap = {
        addBaseTiles(map) {
            assert.equal(map, mockMap);
        },
        async addCityOutline(map, isCurrent) {
            assert.equal(map, mockMap);
            assert.equal(isCurrent(), true);
            cityOutlineCount++;
        }
    };
    global.L = mockLeaflet;
    global.document = {
        getElementById: (id) => (id === 'leafletTestCanvas' ? mockContainer : null)
    };

    try {
        // Step 1: Position A (Mandalagan)
        const latA = 10.67800;
        const lngA = 122.94600;
        await window.renderGeofenceMap('leafletTestCanvas', latA, lngA, 'Barangay 1', 10);

        assert.equal(mapCreationCount, 1, 'Map should be initialized once for Position A');
        assert.ok(createdMarker, 'Marker should be instantiated');
        assert.deepEqual(createdMarker.currentPos, [latA, lngA]);
        assert.equal(createdMarker.isPopupOpen(), true, 'Popup should be open on initial render');
        const popupA = createdMarker.getPopup().getContent();
        assert.ok(popupA.includes('10.67800, 122.94600'), `Popup A should contain Position A coordinates, got: ${popupA}`);

        // Step 2: Position B (Handumanan)
        const latB = 10.60650;
        const lngB = 122.98000;
        await window.renderGeofenceMap('leafletTestCanvas', latB, lngB, 'Handumanan', 15);

        assert.equal(mapCreationCount, 1, 'Map must NOT be recreated unnecessarily when updating position');
        assert.equal(cityOutlineCount, 1);
        assert.deepEqual(createdMarker.currentPos, [latB, lngB], 'Marker must move to Position B');
        const popupB = createdMarker.getPopup().getContent();
        assert.ok(popupB.includes('10.60650, 122.98000'), `Popup B must reflect Position B coordinates, got: ${popupB}`);
        assert.ok(!popupB.includes('10.67800'), 'Popup B must NOT retain stale Position A latitude');
        assert.ok(!popupB.includes('122.94600'), 'Popup B must NOT retain stale Position A longitude');
    } finally {
        global.document = originalDocument;
        window.L = originalWindowL;
        window.BacolodMap = originalBacolodMap;
        global.L = originalGlobalL;
    }
});

test('autoDetectBarangay handles Geolocation permission denied (code 1) cleanly', async () => {
    const originalNavigatorDesc = Object.getOwnPropertyDescriptor(global, 'navigator');
    const originalDocument = global.document;

    const mockStatus = { innerHTML: '' };
    global.document = {
        getElementById: (id) => (id === 'gpsStatus' ? mockStatus : null)
    };

    let watchCallback = null;
    Object.defineProperty(global, 'navigator', {
        value: {
            geolocation: {
                getCurrentPosition: (success, error) => {
                    error({ code: 1, message: 'User denied Geolocation' });
                },
                watchPosition: (success) => {
                    watchCallback = success;
                    return 101;
                },
                clearWatch: () => { }
            }
        },
        configurable: true,
        writable: true
    });

    try {
        const result = await window.autoDetectBarangay({
            statusElId: 'gpsStatus',
            canvasId: 'dummyCanvas'
        });

        assert.equal(result, null, 'autoDetectBarangay should resolve to null on error');
        assert.ok(mockStatus.innerHTML.includes('Location permission denied'), 'Status UI should inform citizen about permission denied');
    } finally {
        if (originalNavigatorDesc) {
            Object.defineProperty(global, 'navigator', originalNavigatorDesc);
        } else {
            delete global.navigator;
        }
        global.document = originalDocument;
    }
});

test('autoDetectBarangay handles Geolocation position unavailable (code 2) cleanly', async () => {
    const originalNavigatorDesc = Object.getOwnPropertyDescriptor(global, 'navigator');
    const originalDocument = global.document;

    const mockStatus = { innerHTML: '' };
    global.document = {
        getElementById: (id) => (id === 'gpsStatus' ? mockStatus : null)
    };

    Object.defineProperty(global, 'navigator', {
        value: {
            geolocation: {
                getCurrentPosition: (success, error) => {
                    error({ code: 2, message: 'Position unavailable' });
                },
                watchPosition: () => 102,
                clearWatch: () => { }
            }
        },
        configurable: true,
        writable: true
    });

    try {
        const result = await window.autoDetectBarangay({
            statusElId: 'gpsStatus',
            canvasId: 'dummyCanvas'
        });

        assert.equal(result, null);
        assert.ok(mockStatus.innerHTML.includes('Location unavailable'), 'Status UI should indicate location unavailable');
    } finally {
        if (originalNavigatorDesc) {
            Object.defineProperty(global, 'navigator', originalNavigatorDesc);
        } else {
            delete global.navigator;
        }
        global.document = originalDocument;
    }
});

test('validateReportGeofence honors exact boundary edges of Bacolod service area', () => {
    // Exactly on the boundary bounds [minLat: 10.45, maxLat: 10.90, minLng: 122.75, maxLng: 123.20]
    const onSouthWest = window.validateReportGeofence(10.4500, 122.7500, 'Barangay 1');
    assert.equal(onSouthWest.isInsideBacolod, true, 'Boundary edge 10.45, 122.75 should be inside service area');

    const onNorthEast = window.validateReportGeofence(10.9000, 123.2000, 'Barangay 1');
    assert.equal(onNorthEast.isInsideBacolod, true, 'Boundary edge 10.90, 123.20 should be inside service area');

    // Just outside the boundary bounds
    const southOfBoundary = window.validateReportGeofence(10.4499, 122.7500, 'Barangay 1');
    assert.equal(southOfBoundary.isInsideBacolod, false, '10.4499 is south of boundary and must be outside');

    const northOfBoundary = window.validateReportGeofence(10.9001, 122.7500, 'Barangay 1');
    assert.equal(northOfBoundary.isInsideBacolod, false, '10.9001 is north of boundary and must be outside');
});

test('autoDetectBarangay keeps the GPS fix without guessing a barangay when address and boundaries are unavailable', async () => {
    const originalNavigatorDesc = Object.getOwnPropertyDescriptor(global, 'navigator');
    const originalDocument = global.document;
    const originalReverseGeocode = window.ReverseGeocode;
    const originalRenderMap = window.renderGeofenceMap;

    window.ReverseGeocode = {
        lookup: async () => {
            throw new Error('Network error: Nominatim service unreachable');
        }
    };
    window.renderGeofenceMap = async () => { };

    Object.defineProperty(global, 'navigator', {
        value: {
            geolocation: {
                getCurrentPosition: (success) => {
                    success({ timestamp: Date.now(), coords: { latitude: 10.6780, longitude: 122.9460, accuracy: 15 } });
                },
                watchPosition: () => 103,
                clearWatch: () => { }
            }
        },
        configurable: true,
        writable: true
    });

    const mockCanvas = { id: 'canvasFallback', style: {}, tagName: 'CANVAS', getContext: () => null };
    const address = { textContent: '' };
    const mockStatus = { innerHTML: '', querySelector: selector => selector === '.geo-address' ? address : null };
    global.document = {
        getElementById: (id) => {
            if (id === 'canvasFallback') return mockCanvas;
            if (id === 'gpsStatus') return mockStatus;
            return null;
        }
    };

    try {
        let detected = null;
        const result = await window.autoDetectBarangay({
            statusElId: 'gpsStatus',
            canvasId: 'canvasFallback',
            onDetected: (barangay, lat, lng, accuracy, purok, address) => {
                detected = { barangay, lat, lng, accuracy, purok, address };
            }
        });

        assert.ok(result, 'Result should be returned despite reverse geocoding failure');
        assert.equal(result.barangay, null);
        assert.equal(detected.barangay, null);
        assert.equal(detected.purok, null, 'Purok should be null on reverse geocode failure');
        assert.equal(address.textContent, '10.67800, 122.94600');
    } finally {
        if (originalNavigatorDesc) {
            Object.defineProperty(global, 'navigator', originalNavigatorDesc);
        } else {
            delete global.navigator;
        }
        global.document = originalDocument;
        window.ReverseGeocode = originalReverseGeocode;
        window.renderGeofenceMap = originalRenderMap;
    }
});



