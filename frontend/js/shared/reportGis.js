(function (root) {
    'use strict';
    function create({ container, openReport, filterForm, legend, state, load = (query, signal) => root.apiRequest(`/api/reports/gis?${new URLSearchParams(query)}`, { signal }) }) {
        const presentation = root.ReportGisPresentation;
        const boundaries = root.BacolodMap;
        let map = null, controller = null, timer = null, active = false, fitting = false, initialized = false;
        let reports = [], snapshot = null, pendingFit = null, popupMarker = null;
        let cityLayer = null, cityReady = null, barangayLayer = null, focusedBarangay = '';
        const barangays = new Map();
        const markers = new Map(), listeners = [];
        const document = container.ownerDocument;
        const locator = presentation.locator(document);
        container.after(locator.controls);
        const expand = presentation.node(document, 'button', 'gis-expand portal-icon-button');
        expand.type = 'button';
        expand.setAttribute('aria-label', 'Open fullscreen map');
        expand.title = 'Open fullscreen map';
        expand.append(presentation.node(document, 'i', 'bx bx-expand'));
        expand.firstChild.setAttribute('aria-hidden', 'true');
        const fullscreen = boundaries.fullscreen({
            canvas: container, trigger: expand, title: 'GIS Map',
            onOpen() {
                fullscreen.footer.append(locator.controls);
                map.invalidateSize({ pan: false });
                fitBounds((barangayLayer || cityLayer)?.getBounds(), 16);
                refresh();
            },
            onClose() {
                container.after(locator.controls);
                if (!active) return;
                map.invalidateSize({ pan: false });
                refresh();
            }
        });
        function listen(target, event, handler) { target?.addEventListener(event, handler); if (target) listeners.push(() => target.removeEventListener(event, handler)); }
        function message(text) { if (state) state.textContent = text; }
        function fitBounds(bounds, maxZoom) {
            if (!bounds?.isValid()) return;
            fitting = true;
            try { map.fitBounds(bounds, { maxZoom, padding: [30, 30], animate: false }); }
            finally { fitting = false; }
        }
        function loadBoundaries(currentMap) {
            cityReady = boundaries.addCityOutline(currentMap, () => map === currentMap).then(layer => {
                if (layer) cityLayer = layer;
            }).catch(() => {
                if (map === currentMap) locator.cityStatus.textContent = 'Bacolod City outline unavailable.';
            });
            boundaries.barangays().then(data => {
                if (map !== currentMap) return;
                for (const feature of data.features) barangays.set(boundaries.key(feature.properties.name), feature);
                const options = [...barangays].sort(([, a], [, b]) => a.properties.name.localeCompare(b.properties.name, 'en', { numeric: true }));
                for (const [key, feature] of options) {
                    const option = document.createElement('option');
                    option.value = key; option.textContent = feature.properties.name; locator.select.append(option);
                }
                locator.select.disabled = false;
                locator.status.textContent = '';
                if (initialized) render(reports);
            }).catch(() => {
                if (map === currentMap) locator.status.textContent = 'Barangay outlines unavailable.';
            });
        }
        function showBarangay(key) {
            if (!active || !map) return;
            clearTimeout(timer); controller?.abort(); map.closePopup();
            barangayLayer?.remove(); barangayLayer = null;
            const feature = barangays.get(key);
            focusedBarangay = feature ? key : '';
            if (feature) {
                barangayLayer = boundaries.addBarangayOutline(map, feature);
            }
            boundaries.setAreaStatus(locator.status, feature, feature ? `Showing ${feature.properties.name}` : '');
            map.invalidateSize();
            fitBounds((barangayLayer || cityLayer)?.getBounds(), 16);
            render([]);
            refresh();
        }
        function initialize() {
            if (map) return;
            if (!root.L) throw new Error('Map library unavailable. Reload to retry.');
            container.classList.add('report-gis-map');
            map = new root.L.LeafletMap(container, { zoomControl: false, attributionControl: true, worldCopyJump: true, minZoom: 3, maxZoom: 19 }).fitWorld();
            new root.L.ZoomControl({
                zoomInText: '<i class="bx bx-plus" aria-hidden="true"></i>',
                zoomOutText: '<i class="bx bx-minus" aria-hidden="true"></i>'
            }).addTo(map);
            boundaries.addBaseTiles(map);
            const expandControl = new root.L.Control({ position: 'topright' });
            expandControl.onAdd = () => {
                root.L.DomEvent.disableClickPropagation(expand);
                return expand;
            };
            expandControl.addTo(map);
            const fitControl = new root.L.Control({ position: 'topleft' });
            fitControl.onAdd = () => {
                const wrapper = document.createElement('div'); wrapper.className = 'leaflet-bar gis-map-control';
                const button = document.createElement('button'); button.type = 'button'; button.title = 'Fit matching reports'; button.setAttribute('aria-label', 'Fit matching reports');
                button.append(presentation.icon(document, 'location-pin')); button.addEventListener('click', () => {
                    if (focusedBarangay) showBarangay(focusedBarangay);
                    else refresh({ fit: true });
                }); wrapper.append(button);
                root.L.DomEvent.disableClickPropagation(wrapper); root.L.DomEvent.disableScrollPropagation(wrapper); return wrapper;
            };
            fitControl.addTo(map);
            if (legend) presentation.legend(legend);
            map.on('moveend', moved);
            map.on('popupopen', event => {
                popupMarker = event.popup._source?.getElement() || null;
                popupMarker?.classList.add('gis-marker-selected');
            });
            map.on('popupclose', event => {
                const marker = event.popup._source?.getElement();
                marker?.classList.remove('gis-marker-selected');
                if (popupMarker === marker) popupMarker = null;
            });
            listen(container, 'keydown', event => {
                if (event.key !== 'Escape' || !popupMarker) return;
                event.preventDefault();
                event.stopPropagation();
                const marker = popupMarker;
                map.closePopup();
                marker.focus();
            });
            loadBoundaries(map);
        }
        function popupLayout() {
            const canvas = container.getBoundingClientRect();
            const clearance = (selector, distance) => Math.ceil(Math.max(8, ...Array.from(
                container.querySelectorAll(selector), control => {
                    const box = control.getBoundingClientRect();
                    return box.width && box.height ? distance(box) + 8 : 0;
                }
            )));
            const left = clearance('.leaflet-left .leaflet-control', box => box.right - canvas.left);
            const right = clearance('.leaflet-right .gis-expand', box => canvas.right - box.left);
            // Leaflet measures the content separately from the 16px margins and wrapper border.
            const maxWidth = Math.max(1, Math.min(276, container.clientWidth - left - right - 34));
            return { maxWidth, minWidth: Math.min(120, maxWidth),
                autoPanPaddingTopLeft: [left, 20], autoPanPaddingBottomRight: [right, 30] };
        }
        function markerKeyboard(marker, label) {
            const element = marker.getElement();
            if (!element) return;
            element.setAttribute('role', 'button'); element.setAttribute('aria-label', label);
            element.addEventListener('keydown', event => {
                if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); marker.openPopup(); }
            });
        }
        function clusterPopup(group) {
            const element = presentation.node(document, 'div', 'gis-report-popup');
            element.append(presentation.node(document, 'h3', '', `${group.length} reports in ${group[0].barangay || 'this area'}`));
            const label = presentation.node(document, 'label', 'gis-cluster-label', 'Select report');
            const select = document.createElement('select');
            for (const row of group) { const option = document.createElement('option'); option.value = row.id; option.textContent = `#${row.id} ${presentation.type(row).title} · ${presentation.status(row.status)[1]}`; select.append(option); }
            label.append(select); element.append(label);
            const preview = presentation.node(document, 'div', 'gis-cluster-preview');
            const update = () => preview.replaceChildren(presentation.popup(document, group.find(row => String(row.id) === select.value) || group[0], openReport));
            select.addEventListener('change', update); update();
            const zoom = presentation.node(document, 'button', 'gis-popup-action', 'Zoom to area'); zoom.type = 'button';
            zoom.addEventListener('click', () => { map.closePopup(); map.fitBounds(group.map(row => [row.latitude, row.longitude]), { maxZoom: Math.min(19, map.getZoom() + 2), padding: [35, 35] }); });
            element.append(preview, zoom); return element;
        }
        function groups(points) {
            const result = new Map();
            for (const row of points) {
                const position = map.project([row.latitude, row.longitude], map.getZoom());
                const key = `${boundaries.key(row.barangay)}:${Math.floor(position.x / 44)}:${Math.floor(position.y / 44)}`;
                if (!result.has(key)) result.set(key, []);
                result.get(key).push(row);
            }
            return [...result.values()];
        }
        function render(input) {
            initialize();
            reports = input.filter(row => row.latitude !== null && row.longitude !== null && Number.isFinite(Number(row.latitude)) && Number.isFinite(Number(row.longitude)) && Math.abs(Number(row.latitude)) <= 90 && Math.abs(Number(row.longitude)) <= 180);
            const visible = new Set();
            const points = focusedBarangay ? reports.filter(row => boundaries.key(row.barangay) === focusedBarangay) : reports;
            for (const group of groups(points)) {
                const clustered = group.length > 1, row = group[0], key = clustered ? `group:${group.map(item => item.id).join(',')}` : `report:${row.id}`;
                visible.add(key);
                const feature = barangays.get(boundaries.key(row.barangay));
                const color = clustered && feature ? boundaries.color(feature) : '';
                const signature = JSON.stringify([group, color]);
                if (markers.get(key)?.signature === signature) continue;
                if (markers.has(key)) map.removeLayer(markers.get(key).marker);
                const view = clustered ? presentation.cluster(group) : presentation.marker(row);
                const marker = new root.L.Marker([Number(row.latitude), Number(row.longitude)], {
                    keyboard: true, title: view.label,
                    icon: new root.L.DivIcon({ className: 'report-gis-marker', html: view.html, iconSize: [36, 44], iconAnchor: [18, 40], popupAnchor: [0, -34] })
                }).addTo(map);
                if (color) marker.getElement().style.setProperty('--gis-area-color', color);
                marker.bindPopup(() => {
                    // Use the current viewport, including after a breakpoint or fullscreen change.
                    Object.assign(marker.getPopup().options, popupLayout());
                    return clustered ? clusterPopup(group) : presentation.popup(document, row, openReport);
                }, { className: 'report-gis-popup', keepInView: true, closeButton: true });
                const tooltip = document.createElement('span'); tooltip.textContent = clustered ? `${group.length} reports · ${row.barangay || 'Unassigned'}` : `${presentation.type(row).title} · ${presentation.status(row.status)[1]}`;
                marker.bindTooltip(tooltip, { direction: 'top', offset: [0, -36], className: 'report-gis-tooltip' });
                markerKeyboard(marker, view.label); markers.set(key, { marker, signature });
            }
            for (const [key, entry] of markers) if (!visible.has(key)) { map.removeLayer(entry.marker); markers.delete(key); }
            return points.length;
        }
        function query() { return filterForm ? Object.fromEntries(new FormData(filterForm)) : {}; }
        async function refresh({ fit = false, reuseSnapshot = false } = {}) {
            if (!active) return;
            initialize();
            if (fit) map.invalidateSize({ pan: false });
            clearTimeout(timer); controller?.abort();
            const current = new AbortController(); controller = current;
            pendingFit = fit ? current : null;
            const filters = query(); message('Loading authorized report locations...');
            try {
                if (fit || snapshot === null || !reuseSnapshot) {
                    const metadata = await load({ ...filters, extentOnly: '1' }, current.signal);
                    if (current.signal.aborted) return;
                    snapshot = metadata.through;
                    if (metadata.bounds && fit) {
                        fitBounds(new root.L.LatLngBounds([[metadata.bounds[1], metadata.bounds[0]], [metadata.bounds[3], metadata.bounds[2]]]), 16);
                    }
                    if (pendingFit === current) pendingFit = null;
                }
                const bounds = map.getBounds(), extent = { west: Math.max(-180, bounds.getWest()), east: Math.min(180, bounds.getEast()), south: Math.max(-90, bounds.getSouth()), north: Math.min(90, bounds.getNorth()) };
                const found = new Map(); let after = 0;
                do {
                    const data = await load({ ...filters, ...extent, through: snapshot, after }, current.signal);
                    if (current.signal.aborted || controller !== current) return;
                    if (!Array.isArray(data.reports) || (data.nextCursor !== null && !Number.isSafeInteger(data.nextCursor))) throw new Error('Invalid map response. Reload the page and retry.');
                    data.reports.forEach(row => found.set(row.id, row));
                    if (data.nextCursor !== null && data.nextCursor <= after) throw new Error('Map loading could not advance. Retry the filters.');
                    after = data.nextCursor;
                    if (after !== null) message(`${found.size} authorized report locations loaded...`);
                } while (after !== null);
                const count = render([...found.values()]);
                message(`${count} authorized report locations in view.`);
                initialized = true;
            } catch (error) {
                fitting = false;
                if (!current.signal.aborted && controller === current) { render([]); message(error.message || 'Could not load report locations. Apply filters to retry.'); }
            } finally {
                if (pendingFit === current) pendingFit = null;
            }
        }
        function moved() {
            if (fitting || pendingFit || !active) return;
            render(reports); clearTimeout(timer); controller?.abort();
            timer = setTimeout(() => refresh({ reuseSnapshot: true }), 180);
        }
        function changed(event) { event?.preventDefault(); snapshot = null; clearTimeout(timer); try { render([]); refresh(); } catch (error) { message(error.message); } }
        listen(filterForm, 'submit', changed);
        if (filterForm && !filterForm.querySelector('[type="submit"]')) listen(filterForm, 'change', changed);
        listen(locator.select, 'change', () => showBarangay(locator.select.value));
        function suspend() { active = false; clearTimeout(timer); controller?.abort(); map?.closePopup(); fullscreen.close(); }
        function destroy() { suspend(); listeners.splice(0).forEach(remove => remove()); fullscreen.destroy(); expand.remove(); locator.controls.remove(); markers.clear(); map?.remove(); map = null; reports = []; snapshot = null; initialized = false; }
        listen(root, 'pagehide', suspend); listen(root, 'session:changed', destroy);
        function start() {
            const wasActive = active; active = true;
            try {
                initialize();
                map.invalidateSize();
                if (wasActive) return;
                if (initialized) refresh();
                else {
                    const startingMap = map;
                    cityReady.then(() => {
                        if (!active || map !== startingMap || focusedBarangay || pendingFit) return;
                        fitBounds(cityLayer?.getBounds(), 15);
                        refresh();
                    });
                }
            }
            catch (error) { message(error.message); }
        }
        listen(root, 'pageshow', event => { if (event.persisted && container.offsetParent !== null) start(); });
        return { render, refresh, start, suspend, destroy, get map() { return map; } };
    }
    root.ReportGis = { create };
})(window);
