window.NEIGHBORLENS_TILE_CONFIG ??= {
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    options: {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> '
    }
};

window.BacolodMap = (() => {
    const loads = new Map();
    const maxAccuracyMeters = 100;
    const boundaryFiles = {
        city: 'bacolod-city-boundary.json',
        barangays: 'bacolod-barangay-boundaries.json',
        displayCity: 'bacolod-display-city.json',
        displayBarangays: 'bacolod-display-barangays.json'
    };
    // Bundled outlines are visual references.
    const showBarangayOutlines = true;
    const palette = ['#7451b6', '#147c96', '#ae4d72', '#986215', '#4d6dbc', '#367546', '#a0473e', '#497788'];
    const key = name => String(name ?? '').trim().toLowerCase();
    const color = feature => palette[Number(feature.properties.code.slice(-3)) % palette.length];

    function cached(key, read) {
        if (!loads.has(key)) {
            loads.set(key, read().catch(error => {
                loads.delete(key);
                throw error;
            }));
        }
        return loads.get(key);
    }

    async function boundaryText(file, checksum) {
        const url = new URL(`assets/${file}`, document.baseURI);
        if (checksum) url.searchParams.set('sha256', checksum);
        const response = await fetch(url, checksum ? undefined : { cache: 'no-cache' });
        if (!response.ok) throw new Error('Boundary data unavailable');
        return (await response.text()).replace(/\r\n/g, '\n');
    }

    function boundaryManifest() {
        return cached('manifest', async () => JSON.parse(await boundaryText('bacolod-boundary-version.json')));
    }

    function load(key) {
        return cached(key, async () => {
            const manifest = await boundaryManifest();
            const isDisplay = key === 'displayCity' || key === 'displayBarangays';
            const displayKey = key === 'displayCity' ? 'city' : 'barangays';
            const entry = isDisplay ? manifest.display?.[displayKey] : manifest[key];
            if (entry?.file !== boundaryFiles[key] || !/^[a-f0-9]{64}$/.test(entry.sha256) ||
                (isDisplay && !/^bacolod-display-osm-land-v\d+$/.test(manifest.display.version))) {
                throw new Error('Invalid boundary manifest');
            }
            const text = await boundaryText(entry.file, entry.sha256);
            // Use versioned URLs even on development origins without Web Crypto.
            if (window.crypto?.subtle) {
                const bytes = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
                const sha256 = Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
                if (sha256 !== entry.sha256) throw new Error('Boundary integrity check failed');
            }
            return JSON.parse(text);
        });
    }

    function addBaseTiles(map) {
        const { url, options } = window.NEIGHBORLENS_TILE_CONFIG;
        return new window.L.TileLayer(url, options).addTo(map);
    }

    async function addCityOutline(map, isCurrent) {
        const data = await load('displayCity');
        if (isCurrent && !isCurrent()) return null;
        const pane = 'bacolod-display-city';
        if (!map.getPane(pane)) map.createPane(pane).style.zIndex = '401';
        return new window.L.GeoJSON(data, {
            pane,
            interactive: false,
            smoothFactor: 0,
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
            style: { className: 'bacolod-city-outline', color: '#7043b7', dashArray: '7 4', fillColor: '#7043b7', fillOpacity: 0.06, weight: 3 }
        }).addTo(map);
    }

    function addBarangayOutline(map, geometry, { nearby = false } = {}) {
        const layer = new window.L.GeoJSON(geometry, {
            attribution: 'Barangays: PSA / NAMRIA with display edge alignment',
            interactive: false,
            smoothFactor: 0,
            style: feature => ({
                className: nearby ? 'bacolod-barangay-outline bacolod-nearby-outline' : 'bacolod-barangay-outline',
                color: color(feature),
                fillOpacity: nearby ? 0.10 : 0.26,
                dashArray: nearby ? '6 5' : null,
                weight: 3
            })
        });
        if (showBarangayOutlines) layer.addTo(map);
        return layer;
    }

    function fitInlineBoundary(map, outline) {
        map.fitBounds(outline.getBounds(), { padding: [12, 12], animate: false });
    }

    // Preserve location hints against the existing service-area reference. Drawing uses the separate display data.
    async function reportAreaAt({ lat, lng }, accuracy) {
        const [barangays, city] = await Promise.all([
            load('barangays').catch(() => null),
            load('city').catch(() => null)
        ]);
        const cityPoint = window.GeoContainment.inspect(lat, lng, city);
        const insideCity = Boolean(cityPoint?.inside);
        const radius = Math.max(Number(accuracy) || 0, 0.001);
        let uncertain = Boolean(cityPoint && cityPoint.edgeMeters <= radius);
        const matches = [], nearby = [];
        for (const feature of barangays?.features || []) {
            const result = window.GeoContainment.inspect(lat, lng, feature);
            if (!result) continue;
            const nearEdge = result.edgeMeters <= radius;
            uncertain ||= nearEdge;
            if (result.inside) matches.push(feature);
            if (nearEdge || result.inside) nearby.push(feature);
        }
        return {
            feature: insideCity && !uncertain && matches.length === 1 ? matches[0] : null,
            nearby: insideCity && (uncertain || matches.length > 1) ? nearby : [],
            insideCity,
            outsideCity: Boolean(cityPoint) && !insideCity && !uncertain
        };
    }

    async function resolveReportArea(position, accuracy, { signal } = {}) {
        const controller = new AbortController();
        const abort = () => controller.abort();
        if (signal?.aborted) abort();
        else signal?.addEventListener('abort', abort, { once: true });
        const timer = setTimeout(abort, 3500);
        const request = window.apiRequest?.('/api/config/report-area', {
            method: 'POST',
            body: { latitude: position.lat, longitude: position.lng, gpsAccuracy: accuracy ?? null },
            signal: controller.signal
        });
        const [reference, resolution] = await Promise.all([reportAreaAt(position, accuracy), request?.catch(() => null)])
            .finally(() => {
                clearTimeout(timer);
                signal?.removeEventListener('abort', abort);
            });
        const boundary = resolution?.status === 'RESOLVED' && resolution.boundary;
        if (boundary) {
            const barangays = await load('displayBarangays').catch(() => null);
            // Keep the API result for submission. Draw the shared map reference by name.
            const displayFeature = barangays?.features.find(feature => key(feature.properties.name) === key(boundary.name));
            return {
                feature: { type: 'Feature', geometry: boundary.geometry, properties: { name: boundary.name, code: String(resolution.barangayId) } },
                displayFeature, insideCity: true, authoritative: true, barangayId: resolution.barangayId
            };
        }
        if (!resolution) return reference;
        if (resolution.status === 'AUTHORITATIVE_POLYGONS_PENDING') return { ...reference, status: resolution.status };
        return {
            ...reference, status: resolution.status, feature: null,
            outsideCity: resolution.boundaryCheckStatus === 'outside_service_area'
        };
    }

    function setAreaStatus(status, feature, label) {
        status.classList.toggle('gis-located', Boolean(feature));
        if (feature) status.style.setProperty('--gis-area-color', color(feature));
        else status.style.removeProperty('--gis-area-color');
        status.textContent = label;
    }

    function fullscreen({ canvas, trigger, title, closeLabel = 'Close map', onOpen, onClose }) {
        const document = canvas.ownerDocument;
        const dialog = document.createElement('dialog');
        dialog.className = 'bacolod-map-dialog';
        dialog.setAttribute('aria-label', title);
        dialog.innerHTML = `<div class="bacolod-map-topbar"><h2></h2>
            <button type="button" class="bacolod-map-button" autofocus><i class="bx bx-x" aria-hidden="true"></i></button>
            </div><div class="bacolod-map-body"></div><footer class="bacolod-map-footer">
                <span><i class="bx bxs-map-alt" aria-hidden="true"></i> Bacolod City display boundary</span>
            </footer>`;
        dialog.querySelector('h2').textContent = title;
        const close = dialog.querySelector('button');
        close.setAttribute('aria-label', closeLabel);
        const body = dialog.querySelector('.bacolod-map-body');
        const footer = dialog.querySelector('footer');
        const position = document.createComment('');
        canvas.before(position);
        document.body.append(dialog);
        trigger.setAttribute('aria-haspopup', 'dialog');
        const open = () => {
            body.append(canvas);
            dialog.showModal();
            onOpen?.();
        };
        const restore = () => {
            if (dialog.open) return;
            position.after(canvas);
            onClose?.();
            trigger.focus({ preventScroll: true });
        };
        const dismiss = () => dialog.close();
        close.addEventListener('click', dismiss);
        trigger.addEventListener('click', open);
        dialog.addEventListener('close', restore);
        return {
            dialog, body, footer, close: dismiss, destroy() {
                trigger.removeEventListener('click', open);
                dialog.removeEventListener('close', restore);
                if (dialog.open) dismiss();
                position.after(canvas);
                position.remove();
                dialog.remove();
            }
        };
    }

    function reportLocationDialog({ canvas, trigger, getState, highlightBarangay = true, savedBarangay, savedBarangayId,
        locationZoom = 16, closeLabel = 'Close location map', onOpen, onClose }) {
        const document = canvas.ownerDocument;
        const fit = document.createElement('button');
        fit.type = 'button';
        fit.className = 'bacolod-map-fit';
        const caption = highlightBarangay ? document.createElement('p') : null;
        if (caption) {
            caption.className = 'bacolod-map-caption';
            caption.hidden = true;
            caption.setAttribute('role', 'status');
            canvas.after(caption);
        }

        let areaView = true, revision = 0, feature = null, nearby = [], outline = null;
        let lookup, inlineView;

        async function refresh({ fitBoundary = true, locationArea } = {}) {
            const request = ++revision;
            await new Promise(resolve => window.requestAnimationFrame(resolve));
            const state = getState();
            if (!state || request !== revision) return;
            const expanded = view.dialog.open;
            if (!expanded && !highlightBarangay) return;
            const { map, marker, cityBoundary, accuracyMeters } = state;
            const location = marker?.getLatLng();
            let area = { insideCity: true };
            if (highlightBarangay && location) {
                if (locationArea || !lookup || lookup.lat !== location.lat || lookup.lng !== location.lng || lookup.accuracyMeters !== accuracyMeters) {
                    lookup = {
                        lat: location.lat, lng: location.lng, accuracyMeters,
                        area: locationArea || resolveReportArea(location, accuracyMeters)
                    };
                }
                area = await lookup.area || area;
            }
            const locationCandidates = !area.feature && Number.isFinite(accuracyMeters) && accuracyMeters <= maxAccuracyMeters
                ? area.nearby || [] : [];
            const display = (area.feature && !area.authoritative || locationCandidates.length)
                ? await load('displayBarangays').catch(() => null) : null;
            if (request !== revision || expanded !== view.dialog.open) return;

            const byName = item => display?.features.find(feature => key(feature.properties.name) === key(item.properties.name));
            const match = area.authoritative ? area.displayFeature || null : (area.feature && byName(area.feature)) || null;
            const candidates = locationCandidates.map(byName).filter(Boolean);
            if (feature !== match || nearby.length !== candidates.length || nearby.some((item, i) => item !== candidates[i])) {
                outline?.remove();
                outline = match || candidates.length ? addBarangayOutline(map, match || candidates, { nearby: !match }) : null;
                feature = match;
                nearby = candidates;
            }

            const name = area.feature?.properties.name;
            const differsFromSaved = name && ((savedBarangay && key(savedBarangay) !== key(name)) ||
                (area.authoritative && savedBarangayId && Number(savedBarangayId) !== Number(area.barangayId)));
            const nearbyNames = nearby.map(item => item.properties.name).join(' / ');
            const label = name ? `${differsFromSaved ? 'GPS: ' : ''}Brgy. ${name.replace(/^Barangay\s+/i, '')}${area.authoritative ? '' : ' \u00b7 Map reference'}`
                : nearbyNames ? `Near ${nearbyNames} boundary \u00b7 Map reference`
                    : area.outsideCity ? 'Outside Bacolod City' : location && !area.insideCity ? 'GPS location' : 'Bacolod City display boundary';
            if (caption) {
                caption.hidden = expanded || (!differsFromSaved && !nearbyNames);
                caption.textContent = caption.hidden ? '' : label;
            }

            state.cityView = expanded && areaView;
            if (!canvas.clientWidth) return;
            map.invalidateSize({ pan: false });
            if (!expanded) {
                if (outline && fitBoundary) fitInlineBoundary(map, outline);
                return;
            }

            setAreaStatus(status, feature, label);
            fit.hidden = !location || !area.insideCity;
            fit.textContent = areaView ? 'Show report location'
                : match ? 'Show barangay boundary' : nearby.length ? 'Show nearby boundaries' : 'Show Bacolod City';
            if (areaView && (!location || area.insideCity)) {
                marker?.closePopup();
                const boundary = outline || await cityBoundary;
                if (boundary && view.dialog.open && request === revision) map.fitBounds(boundary.getBounds(), { padding: [20, 20], animate: false });
            } else if (location) map.setView(location, locationZoom, { animate: false });
        }

        function clear() {
            revision++;
            outline?.remove();
            outline = feature = lookup = null;
            nearby = [];
            if (caption) caption.hidden = true;
            const state = getState();
            if (state) state.cityView = false;
        }

        const view = fullscreen({
            canvas, trigger, title: 'Report location', closeLabel,
            async onOpen() {
                const state = getState();
                inlineView = state?.marker ? {
                    center: state.map.getCenter(), zoom: state.map.getZoom(), location: state.marker.getLatLng(), accuracyMeters: state.accuracyMeters
                } : null;
                if (caption) caption.hidden = true;
                areaView = true;
                fit.hidden = true;
                setAreaStatus(status, null, 'Finding report area…');
                await onOpen?.(view);
                if (view.dialog.open) refresh();
            },
            onClose() {
                const state = getState();
                const location = state?.marker?.getLatLng();
                const restore = location && inlineView && location.equals(inlineView.location) && state.accuracyMeters === inlineView.accuracyMeters;
                if (state) state.cityView = false;
                onClose?.(view);
                if (restore) {
                    state.map.invalidateSize({ pan: false });
                    state.map.setView(inlineView.center, inlineView.zoom, { animate: false });
                }
                refresh({ fitBoundary: !restore });
            }
        });
        const status = view.footer.querySelector('span');
        status.className = 'gis-area-status';
        status.setAttribute('role', 'status');
        view.footer.append(fit);
        fit.addEventListener('click', () => { areaView = !areaView; refresh(); });
        let visible = Boolean(canvas.clientWidth);
        const observer = typeof window.ResizeObserver === 'function' ? new window.ResizeObserver(() => {
            const wasVisible = visible;
            visible = Boolean(canvas.clientWidth);
            if (visible && !wasVisible && !view.dialog.open) refresh();
            else if (visible) getState()?.map.invalidateSize();
        }) : null;
        observer?.observe(canvas);
        return {
            ...view, refresh, clear,
            destroy() {
                observer?.disconnect();
                view.destroy();
                clear();
                caption?.remove();
            }
        };
    }

    return {
        addBaseTiles, addCityOutline, addBarangayOutline, fitInlineBoundary, reportAreaAt, resolveReportArea, setAreaStatus, fullscreen, reportLocationDialog,
        barangays: () => load('displayBarangays'),
        displayBoundaryVersion: async () => (await boundaryManifest()).display?.version,
        boundaryVersion: async () => (await boundaryManifest()).version,
        key,
        color,
        maxAccuracyMeters
    };
})();
