const createCitizenReportLocation = (detect) => {
    let detectedGPS = null;
    let generation = 0;
    let locationMap;
    let tracking = false;
    let submissionCheck;
    const canTrack = () => !document.hidden && (document.body?.dataset.citizenSection || 'submitSection') === 'submitSection';

    function setupLocationMap() {
        const trigger = document.getElementById('citizenMapOpen');
        if (!trigger) return;
        const map = document.getElementById('geoCanvas');
        const unavailable = document.createElement('p');
        unavailable.className = 'bacolod-map-feedback';
        unavailable.setAttribute('role', 'status');
        unavailable.textContent = 'Map unavailable.';
        unavailable.hidden = true;
        locationMap = window.BacolodMap.reportLocationDialog({
            canvas: map, trigger, getState: () => window.getGeofenceMap(map.id),
            async onOpen() {
                if (!window.getGeofenceMap(map.id) || map.style.display === 'none') {
                    await window.renderGeofenceMap(map.id, detectedGPS?.lat, detectedGPS?.lng, detectedGPS?.barangay, detectedGPS?.accuracy);
                }
                unavailable.hidden = Boolean(window.getGeofenceMap(map.id));
            }
        });
        locationMap.dialog.id = 'citizenMapDialog';
        locationMap.body.append(unavailable);
    }

    function mergeDetectedLocation(previous, update) {
        return {
            ...previous,
            lat: update.lat,
            lng: update.lng,
            barangay: update.barangay,
            purok: update.purok !== undefined ? update.purok : previous?.purok,
            address: update.address !== undefined ? update.address : previous?.address,
            accuracy: Number.isFinite(update.accuracy) ? update.accuracy : previous?.accuracy,
            area: update.area,
            timestamp: update.timestamp
        };
    }


    function resolveReportLocation(gps, session) {
        const liveAddress = typeof gps?.address === 'string' ? gps.address.trim() : '';
        const registeredAddress = typeof session?.address === 'string' ? session.address.trim() : '';
        return liveAddress || registeredAddress;
    }

    async function submissionPosition() {
        submissionCheck?.abort();
        const controller = new AbortController();
        submissionCheck = controller;
        const { signal } = controller;
        const checkActive = () => {
            if (signal.aborted || !canTrack()) throw new Error('Location tracking changed. Return to Submit Report and retry.');
        };
        try {
            const position = await window.getCurrentLocation({ requireAccurate: true });
            checkActive();
            const area = await window.BacolodMap?.resolveReportArea(position, position.accuracy, { signal });
            checkActive();
            const barangay = area?.feature?.properties.name || null;
            const nearbyAddress = barangay && barangay === detectedGPS?.barangay &&
                Math.abs(position.timestamp - detectedGPS.timestamp) <= 30_000 && window.gpsFixDistance(detectedGPS, position) <= 20;
            const address = (nearbyAddress && detectedGPS.address) || (barangay ? `${barangay}, Bacolod City` : '');
            return { ...position, area, barangay, address, purok: nearbyAddress ? detectedGPS.purok : null };
        } finally {
            if (submissionCheck === controller) submissionCheck = null;
        }
    }


    async function runAutoGeofence() {
        if (!canTrack()) return null;
        tracking = true;
        const request = ++generation;
        let receivedUpdate = false;
        detectedGPS = null;
        const initial = await detect({
            statusElId: 'gpsStatus',
            canvasId: 'geoCanvas',
            onMapPosition: locationArea => {
                if (request === generation) locationMap?.refresh({ locationArea });
            },
            onDetected: (barangay, lat, lng, accuracy, purok, address, area, timestamp) => {
                if (request !== generation) return;
                detectedGPS = mergeDetectedLocation(receivedUpdate ? detectedGPS : null, { barangay, lat, lng, accuracy, purok, address, area, timestamp });
                receivedUpdate = true;
            }
        });
        if (request === generation && (!receivedUpdate || samePosition(detectedGPS, initial))) detectedGPS = initial;
        return detectedGPS;
    }

    function samePosition(first, second) {
        return first && second && ['lat', 'lng', 'barangay', 'accuracy', 'purok', 'address', 'timestamp']
            .every(key => first[key] === second[key]);
    }

    function suspend() {
        tracking = false;
        generation += 1;
        detectedGPS = null;
        submissionCheck?.abort();
        window.stopAutoDetectBarangay?.('geoCanvas');
    }

    function syncTracking() {
        const active = canTrack();
        if (tracking === active) return;
        if (!active) return suspend();
        void runAutoGeofence();
    }

    function bindTracking() {
        window.addEventListener('citizen:section-changed', syncTracking);
        document.addEventListener('visibilitychange', syncTracking);
        syncTracking();
    }

    function reset() {
        suspend();
        locationMap?.clear();
        const gpsStatus = document.getElementById('gpsStatus');
        if (gpsStatus) gpsStatus.textContent = '';
        const canvas = document.getElementById('geoCanvas');
        if (canvas) canvas.style.display = 'none';
    }

    return { setupLocationMap, runAutoGeofence, submissionPosition, getDetectedGPS: () => detectedGPS,
        mergeDetectedLocation, resolveReportLocation, bindTracking, syncTracking, suspend, reset };
};
