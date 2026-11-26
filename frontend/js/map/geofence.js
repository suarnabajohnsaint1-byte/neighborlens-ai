// ============================================================
// GEOFENCE.JS — Official Bacolod City Barangay Geofencing & Detection
// 61 Official Barangays: 41 Numbered (1 to 41) + 20 Named Barangays
// ============================================================

const BACOLOD_BARANGAYS = [
    // ── Numbered Barangays (1 to 41) ──
    'Barangay 1', 'Barangay 2', 'Barangay 3', 'Barangay 4', 'Barangay 5',
    'Barangay 6', 'Barangay 7', 'Barangay 8', 'Barangay 9', 'Barangay 10',
    'Barangay 11', 'Barangay 12', 'Barangay 13', 'Barangay 14', 'Barangay 15',
    'Barangay 16', 'Barangay 17', 'Barangay 18', 'Barangay 19', 'Barangay 20',
    'Barangay 21', 'Barangay 22', 'Barangay 23', 'Barangay 24', 'Barangay 25',
    'Barangay 26', 'Barangay 27', 'Barangay 28', 'Barangay 29', 'Barangay 30',
    'Barangay 31', 'Barangay 32', 'Barangay 33', 'Barangay 34', 'Barangay 35',
    'Barangay 36', 'Barangay 37', 'Barangay 38', 'Barangay 39', 'Barangay 40',
    'Barangay 41',

    // ── Named Barangays (20) ──
    'Alangilan', 'Alijis', 'Banago', 'Bata', 'Cabug',
    'Estefania', 'Felisa', 'Granada', 'Handumanan', 'Mandalagan',
    'Mansilingan', 'Montevista', 'Pahanocoy', 'Punta Taytay', 'Singcang-Airport',
    'Sum-ag', 'Taculing', 'Tangub', 'Villamonte', 'Vista Alegre'
];
window.BACOLOD_BARANGAYS = BACOLOD_BARANGAYS;

const MAX_REPORT_LOCATION_ACCURACY_METERS = window.BacolodMap?.maxAccuracyMeters ?? 100;
window.MAX_REPORT_LOCATION_ACCURACY_METERS = MAX_REPORT_LOCATION_ACCURACY_METERS;

// ── STRICT NORMALIZATION TO OFFICIAL 61 BARANGAYS ──
window.normalizeToOfficialBarangay = function (input) {
    if (!input || typeof input !== 'string') return null;
    const clean = input.trim();
    if (!clean) return null;
    const lower = clean.toLowerCase();

    // 1. Direct exact match in BACOLOD_BARANGAYS
    const exact = BACOLOD_BARANGAYS.find(b => b.toLowerCase() === clean.toLowerCase());
    if (exact) return exact;

    // 2. Named Barangay matching with common variations/aliases (Checked before generic numbers)
    const namedMap = {
        'alangilan': 'Alangilan',
        'alijis': 'Alijis',
        'banago': 'Banago',
        'bata': 'Bata',
        'cabug': 'Cabug',
        'estefania': 'Estefania',
        'estefanya': 'Estefania',
        'felisa': 'Felisa',
        'granada': 'Granada',
        'handumanan': 'Handumanan',
        'mandalagan': 'Mandalagan',
        'mansilingan': 'Mansilingan',
        'montevista': 'Montevista',
        'pahanocoy': 'Pahanocoy',
        'pahanocoi': 'Pahanocoy',
        'punta taytay': 'Punta Taytay',
        'puntataytay': 'Punta Taytay',
        'taytay': 'Punta Taytay',
        'singcang': 'Singcang-Airport',
        'singcang-airport': 'Singcang-Airport',
        'singcang airport': 'Singcang-Airport',
        'airport': 'Singcang-Airport',
        'sum-ag': 'Sum-ag',
        'sumag': 'Sum-ag',
        'sum ag': 'Sum-ag',
        'taculing': 'Taculing',
        'tangub': 'Tangub',
        'villamonte': 'Villamonte',
        'villa monte': 'Villamonte',
        'vista alegre': 'Vista Alegre',
        'vistaalegre': 'Vista Alegre',
        'vista-alegre': 'Vista Alegre'
    };

    for (const [alias, officialName] of Object.entries(namedMap)) {
        if (new RegExp(`\\b${alias}\\b`, 'i').test(lower)) {
            return officialName;
        }
    }

    // 3. Numbered Barangay match (e.g. "Brgy 1", "Barangay 12", "Brgy. 41", "Bgy 5", "16")
    // Explicitly ignores Purok/Prk numbers so "Purok 5" won't falsely trigger "Barangay 5"
    const strippedOfPurok = clean.replace(/\b(?:purok|prk\.?|puk\.?)\s*#?\s*\d+/gi, ' ');
    const numMatch = strippedOfPurok.match(/\b(?:barangay|brgy\.?|bgy\.?)\s*#?\s*(\d{1,2})\b/i) ||
        strippedOfPurok.match(/\bbrgy\s*(\d{1,2})\b/i) ||
        strippedOfPurok.match(/^(\d{1,2})$/);
    if (numMatch) {
        const num = parseInt(numMatch[1], 10);
        if (num >= 1 && num <= 41) {
            return `Barangay ${num}`;
        }
    }

    for (const name of BACOLOD_BARANGAYS) {
        if (/^Barangay \d+$/i.test(name)) continue;

        const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (new RegExp(`\\b${escapedName}\\b`, 'i').test(clean)) {
            return name;
        }
    }

    return null;
};

function populateBarangaySelects() {
    document.querySelectorAll('select#barangay, select#accBarangay, select#adminFilterBarangay, select#communityFilterBarangay').forEach(select => {
        const current = select.value;
        const isFilter = select.id === 'adminFilterBarangay' || select.id === 'communityFilterBarangay';
        select.innerHTML = isFilter
            ? '<option value="all">All Barangays</option>'
            : '<option value="">— Select Barangay —</option>';
        BACOLOD_BARANGAYS.forEach(name => {
            const option = document.createElement('option');
            option.value = name;
            option.textContent = name;
            select.appendChild(option);
        });
        if (current && [...select.options].some(option => option.value === current)) select.value = current;
    });
}

window.addEventListener('DOMContentLoaded', populateBarangaySelects);


function isInsideBacolodServiceArea(lat, lng) {
    const latitude = Number(lat);
    const longitude = Number(lng);

    return Number.isFinite(latitude) &&
        Number.isFinite(longitude) &&
        latitude >= 10.45 &&
        latitude <= 10.90 &&
        longitude >= 122.75 &&
        longitude <= 123.20;
}

window.removePurokFromAddress = function (address) {
    if (!address || typeof address !== 'string') return '';
    return address
        .replace(/\b(?:purok|prk\.?|puk\.?)\s*#?\s*[^,;|]+\s*(?:[,;|]|$)/gi, '')
        .replace(/\s{2,}/g, ' ')
        .replace(/^\s*[,;|]\s*|\s*[,;|]\s*$/g, '')
        .trim();
};

const gpsOptions = Object.freeze({ enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
const gpsErrors = {
    1: 'Location permission denied. Please allow location access in your browser settings.',
    2: 'Location unavailable. Move to an area with a clearer GPS signal.',
    3: 'Location request timed out. Please allow GPS access and try again.'
};
let pendingCurrentLocation;

function gpsFix(position) {
    const { latitude: lat, longitude: lng, accuracy } = position?.coords || {};
    const timestamp = Number.isFinite(position?.timestamp) ? Math.trunc(position.timestamp) : NaN;
    return { lat, lng, accuracy, timestamp };
}

function validGpsFix(fix, now = Date.now()) {
    return [fix?.lat, fix?.lng, fix?.accuracy].every(Number.isFinite) &&
        Math.abs(fix.lat) <= 90 && Math.abs(fix.lng) <= 180 && fix.accuracy > 0 &&
        Number.isSafeInteger(fix.timestamp) && fix.timestamp > 0 &&
        now - fix.timestamp <= 30_000 && fix.timestamp - now <= 5_000;
}

function gpsDistance(first, second) {
    const latitude = (first.lat + second.lat) / 2 * Math.PI / 180;
    const longitudeDelta = (second.lng - first.lng + 540) % 360 - 180;
    return 111320 * Math.hypot(second.lat - first.lat, longitudeDelta * Math.cos(latitude));
}
window.gpsFixDistance = gpsDistance;

window.getCurrentLocation = function ({ requireAccurate = false } = {}) {
    pendingCurrentLocation ??= new Promise((resolve, reject) => {
        if (!navigator.geolocation) {
            return reject(new Error('Geolocation is not supported by this browser.'));
        }

        let attempts = 0;
        const maxAttempts = 3;

        function acquireLocation() {
            attempts++;

            navigator.geolocation.getCurrentPosition(position => {
                const fix = gpsFix(position);

                if (validGpsFix(fix)) {
                    return resolve(fix);
                }

                if (attempts < maxAttempts) {
                    setTimeout(acquireLocation, 500);
                    return;
                }

                reject(new Error('Location was invalid or out of date. Get a fresh GPS reading and retry.'));
            }, error => {
                reject(new Error(gpsErrors[error.code] || gpsErrors[2]));
            }, gpsOptions);
        }

        acquireLocation();
    }).finally(() => {
        pendingCurrentLocation = null;
    });

    return pendingCurrentLocation.then(fix => {
        if (requireAccurate && fix.accuracy > MAX_REPORT_LOCATION_ACCURACY_METERS) {
            throw new Error(`GPS accuracy must be ${MAX_REPORT_LOCATION_ACCURACY_METERS} meters or better. Move to an area with a clearer GPS signal.`);
        }

        return fix;
    });
};

function isTestMode() {
    try {
        if (typeof window === 'undefined') return false;
        const params = new URLSearchParams(window.location.search);
        return params.get('testMode') === '1';
    } catch (_) {
        return false;
    }
}
window.isNeighborLensTestMode = isTestMode;

// ── VALIDATE REPORT IS INSIDE BARANGAY / BACOLOD JURISDICTION ──
window.validateReportGeofence = function (lat, lng, barangay) {
    const isInsideBacolod = isInsideBacolodServiceArea(lat, lng)
    const targetBarangay = window.normalizeToOfficialBarangay(barangay);
    const testMode = isTestMode();

    return {
        valid: testMode ? true : (isInsideBacolod && Boolean(targetBarangay)),
        isInsideBacolod,
        testMode,
        targetBarangay,
        message: isInsideBacolod
            ? (targetBarangay ? ` Location detected in ${targetBarangay}` : ' Location within Bacolod City service area.')
            : (testMode
                ? `TEST MODE ACTIVE (?testMode=1): Location (${Number(lat).toFixed(4)}, ${Number(lng).toFixed(4)}) is outside Bacolod City jurisdiction, but permitted for development testing.`
                : `GPS coordinates (${Number(lat).toFixed(4)}, ${Number(lng).toFixed(4)}) are outside Bacolod City jurisdiction.`)
    };
};

// ── AUTO GEOFENCE ON PAGE LOAD ──
// Call this from citizen.js — resolves with { lat, lng, barangay, accuracy }
// Updates UI elements by ID and draws mini-map on canvas if present
window.autoDetectBarangay = async function ({
    statusElId = 'gpsStatus',
    selectElId = 'barangay',
    canvasId = 'geoCanvas',
    onDetected = null,
    onPolygonBarangay = null,
    onMapPosition = null
} = {}) {

    const statusEl = document.getElementById(statusElId);
    const selectEl = document.getElementById(selectElId);
    const canvas = document.getElementById(canvasId);
    stopAutoDetectBarangay(canvasId);
    const run = { latest: null, accepted: null, result: null, site: null, status: 'acquiring' };
    liveLocationRuns.set(canvasId, run);
    const currentRun = () => liveLocationRuns.get(canvasId) === run;

    if (statusEl) {
        statusEl.innerHTML = `
            <div class="geo-status geo-status--loading">
                <span class="spinner"></span>
                <span>Detecting your location…</span>
            </div>`;
    }

    const renderMap = window.renderGeofenceMap || renderGeofenceMap;
    const validateGeo = window.validateReportGeofence || validateReportGeofence;
    const isTest = isTestMode();
    let gpsWarning;

    function showWarning(message) {
        if (!statusEl?.ownerDocument) return;
        if (!gpsWarning?.isConnected) {
            gpsWarning = statusEl.ownerDocument.createElement('p');
            gpsWarning.className = 'geo-warning-banner';
            gpsWarning.setAttribute('role', 'status');
            statusEl.append(gpsWarning);
        }
        gpsWarning.textContent = message;
    }

    async function showPosition(lat, lng, barangay, accuracy, sequenceValue, areaUpdate, inlineArea) {
        if (!canvas || !isCurrentLocationRequest(canvasId, sequenceValue)) return;
        canvas.style.display = 'block';
        window._lastDetectedLat = lat;
        window._lastDetectedLng = lng;
        try {
            if (renderMap) await renderMap(canvas.id, lat, lng, barangay, accuracy, inlineArea);
        } catch (mapErr) {
            console.warn('[geofence] Map rendering skipped:', mapErr.message);
            if (!window.getGeofenceMap(canvasId)) showMapFallback(canvas, lat, lng);
        }
        if (isCurrentLocationRequest(canvasId, sequenceValue)) onMapPosition?.(areaUpdate);
    }

    async function applyAcceptedPosition(fix, site, sequenceValue, signal) {
        const { lat, lng, accuracy, timestamp } = fix;
        let barangay = null;
        const registrationArea = onPolygonBarangay && Number.isFinite(accuracy) && accuracy > 0 &&
            accuracy <= MAX_REPORT_LOCATION_ACCURACY_METERS && window.crypto?.subtle
            ? window.BacolodMap?.reportAreaAt({ lat, lng }, accuracy).catch(() => null) : null;
        const areaUpdate = onMapPosition && window.BacolodMap?.resolveReportArea
            ? window.BacolodMap.resolveReportArea({ lat, lng }, accuracy, { signal }).catch(() => null) : null;
        if (accuracy <= MAX_REPORT_LOCATION_ACCURACY_METERS && window.ReverseGeocode?.lookup) {
            site.address ??= Promise.resolve().then(() => window.ReverseGeocode.lookup({
                latitude: lat, longitude: lng, signal: site.controller.signal
            })).catch(() => null);
        }
        const [registrationMatch, mappedArea] = await Promise.all([registrationArea, areaUpdate]);
        if (!isCurrentLocationRequest(canvasId, sequenceValue)) return null;
        const mappedBarangay = (registrationMatch || mappedArea)?.feature?.properties.name;
        if (run.result && run.result.site === site && run.result.area?.feature &&
            run.result.area.feature.properties.name !== mappedBarangay && (onPolygonBarangay || onMapPosition)) {
            run.accepted = run.result.fix;
            run.status = 'uncertain';
            showWarning('The latest GPS fix cannot confirm your barangay. Keeping the previous map location.');
            return null;
        }
        if (onPolygonBarangay) onPolygonBarangay(mappedBarangay || null);
        const mapUpdate = showPosition(lat, lng, barangay, accuracy, sequenceValue, mappedArea, registrationMatch);
        let liveAddress = '';
        let purok = null;
        let geoData = null;

        geoData = await site.address;
        if (!isCurrentLocationRequest(canvasId, sequenceValue)) {
            return null;
        }
        liveAddress = geoData?.formattedAddress || geoData?.displayName || '';
        const reverseBarangay = window.normalizeToOfficialBarangay(geoData?.barangay) ||
            window.normalizeToOfficialBarangay(window.removePurokFromAddress(liveAddress));
        const conflictingAddress = mappedBarangay && reverseBarangay && reverseBarangay !== mappedBarangay;
        purok = conflictingAddress ? null : geoData?.purok || null;
        barangay = reverseBarangay;

        if (onPolygonBarangay) {
            barangay = mappedBarangay || null;
        } else if (onMapPosition) {
            barangay = mappedBarangay || null;
        } else if (!barangay) {
            const reference = await window.BacolodMap?.reportAreaAt({ lat, lng }, accuracy);
            if (!isCurrentLocationRequest(canvasId, sequenceValue)) return null;
            barangay = reference?.feature?.properties.name || null;
        }

        const accuracyWarning = accuracy > MAX_REPORT_LOCATION_ACCURACY_METERS;
        const geoCheck = onPolygonBarangay
            ? {
                valid: Boolean(barangay), message: registrationMatch?.outsideCity
                    ? 'Location is outside Bacolod City.' : 'Current GPS accuracy does not confirm a unique barangay.'
            }
            : barangay
                ? validateGeo(lat, lng, barangay)
                : { valid: isTest, isInsideBacolod: false, testMode: isTest, message: 'Could not match location to Bacolod City.' };

        if (selectEl && barangay) {
            selectEl.value = barangay;
            selectEl.dispatchEvent(new Event('change'));
        }

        const displayAddress = conflictingAddress
            ? `${mappedBarangay}, Bacolod City`
            : (geoData?.offlineFallback ? '' : summarizeBarangayAddress(liveAddress, mappedBarangay)) ||
            (mappedBarangay ? `${mappedBarangay}, Bacolod City` : '');
        if (statusEl) {
            const color = geoCheck.valid ? 'var(--accent-green)' : 'var(--accent-orange)';
            const showJurisdictionWarning = !onMapPosition && !geoCheck.valid && !isTest;
            const statusClass = accuracyWarning || showJurisdictionWarning ? 'warn' : 'ok';
            const displayedBarangay = mappedBarangay || (mappedArea?.outsideCity ? null : barangay);
            const fullAddress = displayAddress || (onMapPosition
                ? 'Address unavailable. View location on map.'
                : `${lat.toFixed(5)}, ${lng.toFixed(5)}`);

            statusEl.innerHTML = `
                <div class="geo-status geo-status--${statusClass}">
                    <div class="citizen-loc-banner">
                        <div class="citizen-loc-address-block">
                            <div class="citizen-loc-top-row">
                                <div class="citizen-loc-detected-pill">
                                    Location detected
                                </div>
                            </div>
                            <div class="citizen-loc-brgy-title geo-brgy"><strong>${escapeGeofenceText(displayedBarangay ? `${mappedArea?.authoritative || !onMapPosition ? 'Barangay' : mappedBarangay ? 'Map reference' : 'Address barangay'}: ${displayedBarangay}` : fullAddress)}</strong></div>
                           ${displayedBarangay ? `
    <div class="citizen-loc-address-sub geo-address"${displayAddress ? ' data-resolved-address' : ''}></div>
` : ''}
                        </div>
                    </div>
                    ${purok ? `<span class="geo-brgy" style="display:none;">Purok: ${escapeGeofenceText(purok)}</span>` : ''}
                    ${accuracyWarning ? `
                    <div class="geo-warning-banner geo-brgy" style="color:var(--accent-orange); font-size:12px; margin-top:8px;">
                        GPS accuracy is too low for a precise report (need ≤${MAX_REPORT_LOCATION_ACCURACY_METERS}m)
                    </div>` : (showJurisdictionWarning ? `
                    <div class="geo-warning-banner geo-brgy" style="color:${color}; font-size:12px; margin-top:8px;">
                        ${escapeGeofenceText(geoCheck.message)}
                    </div>` : '')}
                    ${isTest ? `
                    <div class="geo-test-banner geo-brgy" style="color:var(--accent-blue); font-size:11px; margin-top:4px; font-weight:600;">
                        DEVELOPMENT TEST MODE (?testMode=1) - Geofence bypass active
                    </div>` : ''}
                </div>`;
            const addressEl = statusEl.querySelector('.geo-address');

            if (addressEl) {
                addressEl.textContent = fullAddress;
            }
        }

        await mapUpdate;

        if (!isCurrentLocationRequest(canvasId, sequenceValue)) return null;

        const isInsideBacolod = typeof isInsideBacolodServiceArea === 'function'
            ? isInsideBacolodServiceArea(lat, lng)
            : Boolean(barangay);

        const result = {
            lat,
            lng,
            barangay,
            purok: purok || null,
            address: displayAddress,
            accuracy, timestamp, ...(onMapPosition ? { area: mappedArea } : {}),
            province: geoData?.province || (isInsideBacolod ? 'Negros Occidental' : ''),
            municipality: geoData?.municipality || (isInsideBacolod ? 'Bacolod City' : '')
        };
        run.result = { site, fix, area: registrationMatch || mappedArea };
        run.status = run.latest.accuracy > MAX_REPORT_LOCATION_ACCURACY_METERS ? 'poor-accuracy' : (geoCheck.valid ? 'located' : 'uncertain');
        if (run.status === 'poor-accuracy' && !accuracyWarning) {
            showWarning('Current GPS accuracy is low. The map is showing your last accurate location.');
        }
        onDetected?.(barangay, lat, lng, accuracy, result.purok, displayAddress, mappedArea, timestamp);
        return result;
    }

    async function acceptObservation(fix) {
        if (!currentRun() || !validGpsFix(fix) || (run.latest && fix.timestamp <= run.latest.timestamp)) return null;
        run.latest = fix;
        const previous = run.accepted;
        if (previous?.accuracy <= MAX_REPORT_LOCATION_ACCURACY_METERS && fix.accuracy > MAX_REPORT_LOCATION_ACCURACY_METERS) {
            run.status = 'poor-accuracy';
            showWarning('Current GPS accuracy is low. The map is showing your last accurate location.');
            return null;
        }
        const anchor = run.site?.anchor;
        // Displacement inside the combined accuracy radii cannot establish movement.
        const moved = !anchor || gpsDistance(anchor, fix) > Math.max(12, Math.hypot(anchor.accuracy, fix.accuracy));
        const recovered =
            (run.status === 'unavailable' ||
                previous?.accuracy > MAX_REPORT_LOCATION_ACCURACY_METERS) &&
            fix.accuracy <= MAX_REPORT_LOCATION_ACCURACY_METERS;
        const improved = previous && previous.accuracy - fix.accuracy >= Math.max(5, previous.accuracy * 0.2);
        if (!moved && !recovered && !improved) {
            if (run.status === 'poor-accuracy' || run.status === 'unavailable') {
                run.status = run.result?.area?.feature ? 'located' : 'uncertain';
                gpsWarning?.remove();
            }
            return null;
        }
        if (moved || recovered) {
            run.site?.controller.abort();
            run.site = { anchor: fix, controller: new AbortController(), address: null };
        }
        run.accepted = fix;
        run.status = 'checking';
        const sequence = beginLocationRequest(canvasId);
        run.areaController?.abort();
        run.areaController = new AbortController();
        return applyAcceptedPosition(fix, run.site, sequence, run.areaController.signal);
    }

    function startWatcher() {
        if (!currentRun() || !canvas || !navigator.geolocation?.watchPosition || run.watchId != null) return;
        run.watchId = navigator.geolocation.watchPosition(next => acceptObservation(gpsFix(next)).catch(error => {
            if (currentRun()) console.warn('[geofence] Location update failed:', error.message);
        }), error => {
            if (!currentRun()) return;
            run.status = 'unavailable';
            showWarning(gpsErrors[error.code] || gpsErrors[2]);
        }, gpsOptions);
    }

    try {
        const pos = await window.getCurrentLocation();
        if (!currentRun()) return null;
        const result = acceptObservation(pos);
        startWatcher();
        return await result;
    } catch (err) {
        if (!currentRun()) return null;
        run.status = 'unavailable';

        if (statusEl) {
            statusEl.innerHTML = `
            <div class="geo-status geo-status--error">
                ${escapeGeofenceText(err.message)}
            </div>`;
        }

        startWatcher();
        return null;
    }
};

function summarizeBarangayAddress(address, barangay) {
    if (!barangay || !address) return address;
    const key = value => {
        const label = value.trim().toLowerCase();
        return /^\d+$/.test(label) ? null : label.replace(/^(?:barangay|brgy\.?)\s+/i, '');
    };
    const current = key(barangay);
    const parts = address.split(',').map(value => value.trim());
    if (!parts.some(value => key(value) === current)) return address;
    const official = new Set(BACOLOD_BARANGAYS.map(key));
    return parts.filter(value => key(value) === current || !official.has(key(value))).join(', ');
}

// ── LIVE MAP RENDERER ──
const liveMaps = new Map();
const liveLocationRuns = new Map();
const locationRequestSequences = new Map();
const mapBarangaySelections = new Map();

window.selectGeofenceMapBarangay = async function (canvasId, name) {
    const selection = { feature: null };
    mapBarangaySelections.set(canvasId, selection);
    if (name) {
        const barangays = await window.BacolodMap.barangays().catch(() => null);
        if (mapBarangaySelections.get(canvasId) !== selection) return;
        selection.feature = barangays?.features.find(feature => window.BacolodMap.key(feature.properties.name) === window.BacolodMap.key(name));
    }
    const state = liveMaps.get(canvasId);
    if (state?.marker && !showInlineMapArea(state, selection.feature || state.locationArea?.feature, true) && !state.cityView) {
        state.map.setView(state.marker.getLatLng(), 16);
    }
};

function showInlineMapArea(state, feature, refit = false) {
    const changed = feature !== state.inlineFeature;
    if (changed) {
        state.inlineOutline?.remove();
        state.inlineFeature = feature;
        state.inlineOutline = feature ? window.BacolodMap.addBarangayOutline(state.map, feature) : null;
    }
    if (!state.inlineOutline) return false;
    if (changed || refit) {
        state.map.invalidateSize({ pan: false });
        window.BacolodMap.fitInlineBoundary(state.map, state.inlineOutline);
    }
    return true;
}

function escapeGeofenceText(value) {
    return String(value ?? '').replace(/[&<>]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[character]);
}

function stopAutoDetectBarangay(canvasId) {
    beginLocationRequest(canvasId);
    const run = liveLocationRuns.get(canvasId);
    if (!run) return;
    liveLocationRuns.delete(canvasId);
    run.site?.controller.abort();
    run.areaController?.abort();
    if (run.watchId != null) navigator.geolocation?.clearWatch(run.watchId);
}
window.stopAutoDetectBarangay = stopAutoDetectBarangay;

function beginLocationRequest(sequenceKey) {
    const next = (locationRequestSequences.get(sequenceKey) || 0) + 1;
    locationRequestSequences.set(sequenceKey, next);
    return next;
}

function isCurrentLocationRequest(sequenceKey, sequenceValue) {
    return locationRequestSequences.get(sequenceKey) === sequenceValue;
}

function showMapFallback(container, lat, lng) {
    if (!container) return;
    container.style.display = 'block';
    const coordsText = (Number.isFinite(lat) && Number.isFinite(lng))
        ? `${lat.toFixed(5)}, ${lng.toFixed(5)}`
        : 'Bacolod City';
    const existingCoords = container.getAttribute('data-coords');
    if (existingCoords === coordsText && container.querySelector('.map-fallback-box')) {
        return;
    }
    container.setAttribute('data-coords', coordsText);
    container.innerHTML = `
        <div class="map-fallback-box" style="display:flex; flex-direction:column; align-items:center; justify-content:center; min-height:140px; height:100%; background:rgba(8,11,16,0.95); border:1px dashed rgba(0,210,255,0.3); border-radius:8px; padding:16px; text-align:center; color:var(--text-dim); font-size:0.8rem; box-sizing:border-box;">
            <div style="font-weight:700; color:var(--accent-blue); margin-bottom:6px;">
                ${coordsText}
            </div>
            <div style="font-size:0.75rem; color:var(--text-dim); margin-bottom:6px; max-width:360px;">
                Map unavailable.
            </div>
        </div>`;
}

window.getGeofenceMap = canvasId => liveMaps.get(canvasId);
window.renderGeofenceMap = async function (canvasId, lat, lng, activeBarangay, accuracy = 0, inlineArea) {
    const container = document.getElementById(canvasId);
    if (!container) return;

    const hasLocation = Number.isFinite(lat) && Number.isFinite(lng);
    const citizenMap = canvasId === 'geoCanvas';
    if (hasLocation) {
        window._lastDetectedLat = lat;
        window._lastDetectedLng = lng;
    }

    if (window.L && container.tagName !== 'CANVAS') {
        container.style.display = 'block';
        let mapState = liveMaps.get(canvasId);

        // If container was destroyed and recreated (e.g. reopening report modal)
        if (mapState && mapState.map && mapState.map.getContainer() !== container) {
            try {
                mapState.map.remove();
            } catch (_) { }
            mapState = null;
            liveMaps.delete(canvasId);
        }

        if (!mapState) {
            const map = new L.LeafletMap(container, { zoomControl: true, attributionControl: true });
            const tiles = window.BacolodMap.addBaseTiles(map);
            mapState = { map, tiles, marker: null, accuracy: null };
            const tileStatus = canvasId === 'signupGeoCanvas' ? document.getElementById('signupMapStatus') : null;
            if (tileStatus) {
                tiles.on('loading', () => { tileStatus.hidden = true; });
                tiles.on('tileerror', () => {
                    tileStatus.textContent = 'Some map tiles could not load.';
                    tileStatus.hidden = false;
                });
            }
            liveMaps.set(canvasId, mapState);
            mapState.cityBoundary = window.BacolodMap.addCityOutline(map, () => liveMaps.get(canvasId)?.map === map)
                .catch(() => null);
        }

        const map = mapState.map;
        if (!hasLocation) {
            mapState.marker?.remove();
            mapState.accuracy?.remove();
            mapState.inlineOutline?.remove();
            mapState.inlineOutline = mapState.inlineFeature = null;
            mapState.marker = mapState.accuracy = null;
            map.invalidateSize({ pan: false });
            map.setView([10.67, 122.98], 12);
            const city = await mapState.cityBoundary;
            if (city && !mapState.marker && liveMaps.get(canvasId) === mapState) map.fitBounds(city.getBounds());
            return;
        }
        const position = [lat, lng];
        if (!mapState.cityView && (!mapState.marker || map.getBounds?.()?.contains(position) === false)) {
            map.setView(position, mapState.marker ? map.getZoom() : 16);
        }

        const locationLabel = canvasId === 'signupGeoCanvas' ? 'Live registration location' : 'Live report location';
        const popupContent = `<strong>${locationLabel}</strong><br>${lat.toFixed(5)}, ${lng.toFixed(5)}`;
        if (mapState.marker) {
            mapState.marker.setLatLng(position);
            if (typeof mapState.marker.setPopupContent === 'function') {
                mapState.marker.setPopupContent(popupContent);
            } else if (mapState.marker.getPopup && mapState.marker.getPopup()) {
                mapState.marker.getPopup().setContent(popupContent);
            }
            if (typeof mapState.marker.isPopupOpen === 'function' && mapState.marker.isPopupOpen()) {
                mapState.marker.openPopup();
            }
        } else {
            mapState.marker = new L.Marker(position).addTo(map).bindPopup(popupContent);
            if (!citizenMap && !inlineArea?.feature) mapState.marker.openPopup();
        }

        const accuracyMeters = Number(accuracy);
        mapState.accuracyMeters = Number.isFinite(accuracy) ? accuracy : null;
        if (Number.isFinite(accuracyMeters) && accuracyMeters > 0) {
            if (mapState.accuracy) mapState.accuracy.setLatLng(position).setRadius(accuracyMeters);
            else mapState.accuracy = new L.Circle(position, {
                radius: accuracyMeters,
                color: '#00d2ff',
                fillColor: '#00d2ff',
                fillOpacity: 0.12,
                weight: 1
            }).addTo(map);
        }

        mapState.locationArea = inlineArea;
        const feature = mapBarangaySelections.get(canvasId)?.feature || inlineArea?.feature;
        if (!showInlineMapArea(mapState, feature)) setTimeout(() => map.invalidateSize(), 50);
        return;
    }

    showMapFallback(container, lat, lng);
};
