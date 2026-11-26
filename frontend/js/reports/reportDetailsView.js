(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.ReportDetailsView = api;
})(typeof self !== 'undefined' ? self : this, function (root) {
    'use strict';

    const STATUS_NOTES = Object.freeze({
        pending: 'Awaiting barangay review',
        ongoing: 'Barangay review in progress',
        resolved: 'Marked resolved by the reviewer',
        rejected: 'Marked rejected by the reviewer'
    });

    function mount(container, data, options = {}) {
        const view = root.ReportPresentation;
        const document = container.ownerDocument;
        const escape = view.escape;
        const apiBase = options.apiBase || '/';
        const { report, history, historyAvailable } = data;
        const row = (label, value) => `<dt>${escape(label)}</dt><dd>${escape(value ?? 'Not recorded')}</dd>`;
        const damage = view.damage(report);
        const photos = options.publication ? data.publicMedia : view.evidence(report, apiBase);
        const landmark = !options.publication && report.landmark ? report.landmark : null;
        const landmarkUrl = landmark ? view.imageUrl(landmark.imagePath, apiBase) : null;
        const gps = options.publication ? null : view.coordinates(report);
        const accuracy = view.number(report.gps_accuracy);
        const status = view.statuses[report.status] || 'Status not recorded';
        const events = view.timeline(report, history);
        const allowed = options.publication ? [] : root.ReportVocabulary.reviewStatuses(options.role || (options.canReview ? 'admin' : null), report.status);
        const canReview = allowed.length > 0;
        const staff = !options.publication && ['admin', 'barangay'].includes(options.role);
        const zoomable = Boolean(root.EvidenceViewer && root.EvidenceZoom);
        const submitted = view.date(report.created_at);
        const pid = name => escape(`${options.idPrefix || ''}${name}`);
        let map = null;
        let destroyed = false;
        const listeners = [];
        const draft = options.state?.status === report.status ? options.state : {};
        let actionFiles = draft.actionFiles || [], actionKey = draft.actionKey || root.crypto.randomUUID();
        const previewUrls = [];
        const proofMarkup = event => (event.proofs || []).map(proof => {
            const url = view.imageUrl(proof.imagePath, apiBase);
            return url ? `<button type="button" class="rd-action-photo" aria-label="Enlarge action photo"><img data-evidence-url="${escape(url)}" alt="Action evidence photo ${escape(proof.imageOrder)}" loading="lazy"></button>` : '';
        }).join('');

        function listen(target, type, handler, settings) {
            target.addEventListener(type, handler, settings);
            listeners.push(() => target.removeEventListener(type, handler, settings));
        }

        const photoMarkup = photos.map(photo => {
            const tag = zoomable ? 'button' : 'div';
            const attributes = tag === 'button'
                ? `type="button" aria-label="Enlarge submitted evidence photo ${photo.order}" ${photo.url ? '' : 'disabled'}`
                : `role="group" aria-label="Submitted evidence photo ${photo.order} of ${photos.length}"`;
            return `<li class="rd-slide"><${tag} class="rd-photo" data-photo="${photo.order}" ${attributes}>
                ${photo.url ? `<img data-evidence-url="${escape(photo.url)}" data-evidence-report="${escape(report.id)}" data-evidence-order="${photo.order}" alt="Submitted evidence photo ${photo.order}" referrerpolicy="no-referrer" loading="lazy">` : `<span class="rd-photo-placeholder">Photo ${photo.order} not recorded</span>`}
                <span class="rd-photo-label">Photo ${photo.order} of ${photos.length}</span></${tag}></li>`;
        }).join('');

        container.classList.add('rd-view');
        container.classList.toggle('rd-staff', staff);
        container.innerHTML = `<header class="rd-header">
            <div>${options.showTitle === false ? '' : '<h1>Report Details</h1>'}<p class="rd-metadata">Report #${escape(report.id)}${submitted ? ` <span aria-hidden="true">&middot;</span> Submitted ${escape(submitted)}` : ''}</p></div>
            <div class="rd-status" data-status="${escape(report.status)}"><strong>${escape(status)}</strong><p>${escape(STATUS_NOTES[report.status] || '')}</p></div>
        </header>
        <div class="rd-overview">
            <section class="rd-carousel" aria-roledescription="carousel" aria-label="Submitted evidence">
                <ul class="rd-photos" tabindex="0" aria-label="Evidence photos. Use the arrow keys to move between photos.">${photoMarkup}</ul>
                <div class="rd-carousel-controls">
                    <button type="button" class="rd-icon-button" data-carousel="previous" aria-label="Previous photo"><i class="bx bx-chevron-left" aria-hidden="true"></i></button>
                    <span class="rd-carousel-position" aria-live="polite">Photo 1 of ${photos.length}</span>
                    <button type="button" class="rd-icon-button" data-carousel="next" aria-label="Next photo"><i class="bx bx-chevron-right" aria-hidden="true"></i></button>
                </div>
            </section>
            <section class="rd-summary" aria-labelledby="${pid('damageHeading')}"><h2 id="${pid('damageHeading')}">Reported Damage</h2>
                <p class="rd-damage-title">${escape(damage.title)}</p><p class="rd-note">${escape(damage.note)}</p>
                ${damage.fields.length ? `<dl class="rd-facts">${damage.fields.map(([label, value]) => row(label, value)).join('')}</dl>` : ''}
            </section>
        </div>
        <div class="rd-details-grid">
            <section class="rd-section rd-description-section" aria-labelledby="${pid('descriptionHeading')}"><h2 id="${pid('descriptionHeading')}"><i class="bx bx-file" aria-hidden="true"></i>Description</h2><p class="rd-description">${escape(report.description || 'Description not recorded.')}</p></section>
            ${landmark ? `<section class="rd-section rd-landmark-section" aria-labelledby="${pid('landmarkHeading')}">
                <h2 id="${pid('landmarkHeading')}"><i class="bx bx-map-pin" aria-hidden="true"></i>Nearby Landmark</h2>
                ${landmarkUrl ? `<div class="rd-landmark-photo"><img data-evidence-url="${escape(landmarkUrl)}" alt="Nearby landmark photo" referrerpolicy="no-referrer" loading="lazy"></div>` : ''}
                <p class="rd-landmark-description">${escape(landmark.description || '')}</p>
            </section>` : ''}
            <section class="rd-section rd-location" aria-labelledby="${pid('locationHeading')}">
                <div><h2 id="${pid('locationHeading')}"><i class="bx bx-map" aria-hidden="true"></i>Location</h2>
                    <h3 class="rd-location-address">${escape(report.location || 'Address not recorded')}</h3><p>${escape(report.barangay || 'Barangay not recorded')}</p>
                    <dl class="rd-gps"><div>${row('Latitude', gps ? gps.lat.toFixed(5) : null)}</div><div>${row('Longitude', gps ? gps.lng.toFixed(5) : null)}</div><div>${row('Barangay', report.barangay)}</div><div>${row('GPS accuracy', accuracy !== null && accuracy >= 0 ? `${accuracy} m` : null)}</div></dl>
                </div>
                <div class="rd-map-wrap" id="${pid('mapWrap')}"><div class="rd-map" id="${pid('reportMap')}" role="region" aria-label="Recorded report location map"></div>
                    <button class="rd-icon-button rd-map-toggle" id="${pid('expandMap')}" type="button" aria-label="Enlarge map" title="Enlarge map" ${gps ? '' : 'hidden'}><i class="bx bx-expand" aria-hidden="true"></i></button>
                    <p class="rd-map-status" id="${pid('mapStatus')}" ${gps ? 'hidden' : ''}>No recorded coordinates; map unavailable.</p>
                </div>
            </section>
        </div>
        <section class="rd-section rd-review-section" aria-labelledby="${pid('reviewHeading')}"><div class="rd-review-grid"><section class="rd-activity"><h2 id="${pid('reviewHeading')}"><i class="bx bx-time-five" aria-hidden="true"></i>Report activity</h2>
            ${events.length ? `<ol class="rd-timeline">${events.map(event => `<li><strong>${escape(event.title)}</strong><time datetime="${escape(event.time)}">${escape(view.date(event.time))}</time><p>${escape(event.description)}</p>${event.actor ? `<p class="rd-note">Updated by ${escape(event.actor)}</p>` : ''}<div class="rd-action-photos">${proofMarkup(event)}</div></li>`).join('')}</ol>` : '<p class="rd-note">No dated status events were recorded.</p>'}
            ${historyAvailable ? '' : '<p class="rd-note" role="status">Review history could not be loaded. Refresh to try again.</p>'}
            </section>${canReview ? `<section class="rd-operational-actions"><h2>Operational actions</h2><form class="rd-review-form" id="${pid('reportReviewForm')}"><label for="${pid('reviewNote')}">Action description / rejection reason</label><textarea id="${pid('reviewNote')}" name="note" maxlength="500" rows="2">${escape(draft.note || '')}</textarea><label for="${pid('actionPhotos')}">Action photos (required to resolve)</label><p class="rd-note">Resolution requires a description and proof of action. Choose up to five photos, at most 10 MB each.</p><button type="button" class="portal-button-secondary rd-upload-button" data-pick-proof><i class="bx bx-upload" aria-hidden="true"></i>Choose action photos</button><input class="rd-file-input" id="${pid('actionPhotos')}" type="file" name="photos" accept="image/jpeg,image/png,image/webp" multiple><div class="rd-action-previews"></div><div class="rd-review-actions">${allowed.includes('rejected') ? '<button type="submit" name="status" value="rejected" class="portal-button-secondary"><i class="bx bx-x" aria-hidden="true"></i>Reject report</button>' : ''}${report.status === 'pending' ? '<button type="submit" name="status" value="ongoing"><i class="bx bx-play" aria-hidden="true"></i>Mark ongoing</button>' : ''}<button type="submit" name="status" value="resolved"><i class="bx bx-check" aria-hidden="true"></i>Resolve report</button></div><p class="rd-review-message" id="${pid('reviewMessage')}" role="status" aria-live="polite"></p></form></section>` : ''}</div>
        </section>`;

        if (options.publication) {
            container.querySelector('.rd-details-grid').remove();
            container.querySelector('.rd-review-section').remove();
            container.querySelector('.rd-summary .rd-note')?.remove();
            container.querySelector('.rd-summary .rd-facts')?.remove();
            container.querySelector('.rd-carousel').setAttribute('aria-label', 'Shared community photos');
            container.querySelectorAll('.rd-photo img').forEach(image => { image.alt = image.alt.replace('Submitted evidence', 'Shared community'); });
            const section = document.createElement('section'); section.className = 'rd-section';
            const heading = document.createElement('h2'); heading.textContent = 'Community update';
            const text = document.createElement('p'); text.textContent = report.description || 'No public description shared.';
            const location = document.createElement('p'); location.textContent = report.barangay;
            section.append(heading, text, location); container.append(section);
        }

        const track = container.querySelector('.rd-photos');
        const slides = [...container.querySelectorAll('.rd-slide')];
        const position = container.querySelector('.rd-carousel-position');
        const previous = container.querySelector('[data-carousel="previous"]');
        const next = container.querySelector('[data-carousel="next"]');

        const carousel = root.MediaCarousel.mount({ track, slides, position, previous, next, initial: options.state?.index || 0 });
        const currentSlide = carousel.index;
        listeners.push(() => carousel.destroy());

        root.ReportEvidence?.hydrate(container);
        if (zoomable) {
            const viewer = root.EvidenceViewer.mount(container, { prefix: options.idPrefix || '' });
            listeners.push(() => viewer.destroy());
        }

        const mapWrap = container.querySelector('.rd-map-wrap');
        const mapToggle = container.querySelector('.rd-map-toggle');
        const mapStatus = container.querySelector('.rd-map-status');
        let fullscreen = null;

        if (gps) {
            if (!root.L) {
                mapToggle.hidden = true;
                mapStatus.hidden = false;
                mapStatus.textContent = 'Map unavailable. Recorded coordinates are shown alongside.';
            } else {
                try {
                    const accent = getComputedStyle(container).getPropertyValue('--color-accent').trim() || '#087af8';
                    const canvas = container.querySelector('.rd-map');
                    const coordinates = [gps.lat, gps.lng];
                    map = new root.L.LeafletMap(canvas).setView(options.state?.center || coordinates, options.state?.zoom || 17);
                    const tiles = root.BacolodMap.addBaseTiles(map);
                    tiles.on('tileerror', () => { mapStatus.hidden = false; mapStatus.textContent = 'Map tiles unavailable. Recorded coordinates remain visible.'; });
                    const marker = new root.L.Marker(coordinates).addTo(map);
                    if (staff) marker.bindTooltip(escape(report.barangay || 'Report location'), { permanent: true, direction: 'right' });
                    if (accuracy !== null && accuracy > 0) new root.L.Circle(coordinates, { radius: accuracy, color: accent, fillOpacity: 0.08, weight: 1 }).addTo(map);
                    const currentMap = map;
                    const mapState = { map, marker, accuracyMeters: accuracy, cityBoundary: root.BacolodMap.addCityOutline(map, () => map === currentMap).catch(() => null) };
                    fullscreen = root.BacolodMap.reportLocationDialog({
                        canvas, trigger: mapToggle, getState: () => map ? mapState : null,
                        savedBarangay: report.barangay, savedBarangayId: report.barangay_id,
                        highlightBarangay: !staff, locationZoom: staff ? 17 : 16,
                        closeLabel: staff ? 'Restore map size' : 'Close location map',
                        onOpen(view) {
                            mapWrap.classList.add('is-expanded');
                            view.body.append(mapStatus);
                            mapStatus.classList.add('bacolod-map-feedback');
                        },
                        onClose() {
                            mapWrap.classList.remove('is-expanded');
                            mapStatus.classList.remove('bacolod-map-feedback');
                            mapWrap.append(mapStatus);
                        }
                    });
                    fullscreen.refresh({ fitBoundary: !options.state?.center });

                } catch {
                    mapToggle.hidden = true;
                    mapStatus.hidden = false;
                    mapStatus.textContent = 'Map unavailable. Recorded coordinates are shown alongside.';
                }
            }
        }

        const form = container.querySelector('.rd-review-form');
        if (!options.publication && options.role !== 'admin' && root.CommunityPublication) listeners.push(root.CommunityPublication.mount(container, report, options.role));
        let saving = false;
        if (form) {
            const previews = form.querySelector('.rd-action-previews');
            const feedback = form.querySelector('.rd-review-message');
            function renderPreviews() {
                previewUrls.splice(0).forEach(url => root.URL.revokeObjectURL(url));
                previews.replaceChildren();
                actionFiles.forEach((file, index) => {
                    const item = document.createElement('div'), image = document.createElement('img'), remove = document.createElement('button'), enlarge = document.createElement('button');
                    const url = root.URL.createObjectURL(file); previewUrls.push(url);
                    image.src = url; image.alt = `Selected action photo ${index + 1}`;
                    remove.type = 'button'; remove.dataset.removeProof = index; remove.setAttribute('aria-label', `Remove action photo ${index + 1}`); remove.title = remove.getAttribute('aria-label'); remove.innerHTML = '<i class="bx bx-x" aria-hidden="true"></i>';
                    enlarge.type = 'button'; enlarge.className = 'rd-action-photo rd-selected-proof'; enlarge.setAttribute('aria-label', `Enlarge selected action photo ${index + 1}`); enlarge.append(image); item.append(enlarge, remove); previews.append(item);
                });
            }
            renderPreviews();
            listen(form.querySelector('[data-pick-proof]'), 'click', () => form.elements.photos.click());
            listen(form.elements.photos, 'change', () => {
                const files = [...form.elements.photos.files];
                if (files.length > 5 || files.some(file => !['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 10 * 1024 * 1024)) {
                    feedback.textContent = 'Choose up to five JPEG, PNG, or WebP photos, at most 10 MB each.';
                } else { actionFiles = files; actionKey = root.crypto.randomUUID(); feedback.textContent = ''; renderPreviews(); }
                form.elements.photos.value = '';
            });
            listen(previews, 'click', event => {
                const button = event.target.closest('[data-remove-proof]'); if (!button) return;
                actionFiles.splice(Number(button.dataset.removeProof), 1); actionKey = root.crypto.randomUUID(); renderPreviews();
            });
            listen(form.elements.note, 'input', () => { actionKey = root.crypto.randomUUID(); });
            listen(form, 'submit', async event => {
                event.preventDefault();
                if (saving) return;
                const nextStatus = event.submitter?.value;
                if (!allowed.includes(nextStatus) || typeof options.onReview !== 'function') return;
                const note = form.elements.note.value.trim();
                const result = form.querySelector('.rd-review-message');
                if (nextStatus === 'resolved' && (!note || !actionFiles.length)) { result.textContent = 'Add an action description and at least one completion photo.'; return; }
                if (nextStatus === 'rejected') {
                    if (note.length < 10 || !/[\p{L}\p{N}]/u.test(note)) { result.textContent = 'Provide a rejection reason of at least 10 characters.'; return; }
                    saving = true;
                    const confirmed = await root.PortalComponents.confirmAction(document, { title: 'Reject report?', message: 'The report will be closed with this reason. It cannot be reopened. Community publication is a separate decision.', label: 'Reject report' });
                    if (!confirmed || destroyed) { saving = false; return; }
                }
                saving = true;
                form.querySelectorAll('button, textarea, input').forEach(control => { control.disabled = true; });
                result.textContent = 'Saving review...';
                try {
                    await options.onReview(nextStatus, note, { files: nextStatus === 'rejected' ? [] : actionFiles, requestKey: actionKey });
                } catch (error) {
                    if (!destroyed) result.textContent = error?.message || 'Review could not be saved. Check your connection and try again.';
                } finally {
                    saving = false;
                    if (!destroyed && form.isConnected) form.querySelectorAll('button, textarea, input').forEach(control => { control.disabled = false; });
                }
            });
        }

        const severityPanel = !options.publication && options.role && root.ReportSeverityPanel?.mount(container, report, {
            role: options.role, draft: options.state?.severity, onSaved: options.onSeveritySaved
        });
        if (severityPanel) listeners.push(() => severityPanel.destroy());
        const reviewPanel = staff && root.ReportReviewPanel
            ? root.ReportReviewPanel.mount(container, report, { state: options.state?.workflow, role: options.role, onSeverityData: severityPanel?.update }) : null;
        if (reviewPanel) listeners.push(() => reviewPanel.destroy());

        let tools;
        if (staff && reviewPanel) {
            container.querySelector('.rd-header h1')?.replaceChildren(`Report #${report.id}`);
            const metadata = container.querySelector('.rd-metadata');
            metadata.textContent = `${root.ReportVocabulary.displayLabelFor(report.originalAi?.detected ? report.originalAi.canonical_class : report.ai_category) || damage.title} \u00b7 Barangay ${report.barangay || 'not assigned'}`;
            if (options.role === 'admin' && damage.model) metadata.append(` \u00b7 ${damage.model}`);
            const headingLine = document.createElement('div'); headingLine.className = 'rd-heading-line';
            metadata.parentElement.append(headingLine); headingLine.append(metadata, container.querySelector('.rd-status'));
            const top = document.createElement('div'); top.className = 'rd-staff-top';
            const overview = container.querySelector('.rd-overview'), detailsGrid = container.querySelector('.rd-details-grid'), summary = container.querySelector('.rd-summary');
            top.append(container.querySelector('.rd-carousel'), ...(options.role === 'admin' ? [] : [summary]), container.querySelector('.rd-description-section'), container.querySelector('.rd-location'));
            overview.before(top); overview.remove(); detailsGrid.remove();
            const panel = container.querySelector('.rd-workflow-grid'), columns = document.createElement('div'); columns.className = 'rd-staff-columns';
            const left = document.createElement('div'); left.className = 'rd-staff-left';
            const right = document.createElement('div'); right.className = 'rd-staff-right';
            const activity = container.querySelector('.rd-review-section'), operation = activity.querySelector('.rd-operational-actions');
            if (operation) operation.remove();
            left.append(activity, panel.querySelector('.rd-citizen-comments')); right.append(panel.querySelector('.rd-coordination'));
            columns.append(left, right); panel.prepend(columns);
            if (options.role === 'barangay' && operation) {
                tools = document.createElement('details'); tools.className = 'rd-staff-tools rd-section'; tools.open = options.state?.toolsOpen ?? true;
                const toggle = document.createElement('summary'); toggle.textContent = 'Manage Report'; tools.append(toggle);
                const toolGrid = document.createElement('div'); toolGrid.className = 'rd-staff-tool-grid';
                toolGrid.append(operation);
                tools.append(toolGrid); left.insertBefore(tools, left.querySelector('.rd-citizen-comments'));
            } else if (options.role === 'admin') summary.remove();
            root.requestAnimationFrame?.(() => { if (!destroyed) map?.invalidateSize(); });
        }

        let incidentPanel;
        if (!options.publication && root.IncidentReviewPanel && typeof root.apiRequest === 'function') {
            incidentPanel = root.IncidentReviewPanel.mount(container, report, { role: options.role });
            listeners.push(() => incidentPanel.destroy());
        }

        return {
            report,
            refreshReview: () => Promise.all([reviewPanel?.refresh(), incidentPanel?.refresh()]),
            state: () => ({ toolsOpen: tools?.open, workflow: reviewPanel?.state(), severity: severityPanel?.state(), status: report.status, note: form?.elements.note.value, actionFiles: actionFiles.slice(), actionKey, index: currentSlide(), center: map ? [map.getCenter().lat, map.getCenter().lng] : null, zoom: map?.getZoom() }),
            isMapExpanded: () => Boolean(fullscreen?.dialog.open),
            collapseMap: () => fullscreen?.close(),
            destroy() {
                destroyed = true;
                previewUrls.splice(0).forEach(url => root.URL.revokeObjectURL(url));
                fullscreen?.destroy();
                listeners.splice(0).forEach(remove => remove());
                container.querySelectorAll('img[data-evidence-url]').forEach(image => root.ReportEvidence?.release(image));
                if (map) { map.remove(); map = null; }
                container.replaceChildren();
            }
        };
    }

    function signature(data) {
        return JSON.stringify({ ...data.report, images: data.report.images?.map(image => [image.id, image.imageOrder]), image_path: null, history: data.history });
    }

    return { mount, signature };
});
