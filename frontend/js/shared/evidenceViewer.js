(function (root) {
    'use strict';
    function mount(container, { prefix = '' } = {}) {
        const document = container.ownerDocument;
        const dialog = document.createElement('dialog');
        dialog.id = `${prefix}evidenceDialog`; dialog.className = 'rd-dialog';
        dialog.setAttribute('aria-label', 'Evidence photo');
        dialog.innerHTML = `<div class="rd-dialog-heading"><div><h2 data-viewer-title>Evidence photo</h2><p class="rd-dialog-subtitle">Report evidence</p></div>
            <div class="rd-dialog-actions"><div class="rd-zoom-toolbar" role="toolbar" aria-label="Zoom controls">
                <button type="button" class="rd-icon-button" data-zoom="out" aria-label="Zoom out" title="Zoom out"><i class="bx bx-minus" aria-hidden="true"></i></button>
                <button type="button" class="rd-icon-button rd-zoom-reset" data-zoom="reset" aria-label="Reset zoom" title="Reset zoom">100%</button>
                <button type="button" class="rd-icon-button" data-zoom="in" aria-label="Zoom in" title="Zoom in"><i class="bx bx-plus" aria-hidden="true"></i></button></div>
                <button type="button" class="rd-icon-button" data-zoom="fullscreen" aria-label="Toggle full screen" title="Full screen"><i class="bx bx-fullscreen" aria-hidden="true"></i></button>
                <button type="button" class="rd-icon-button" data-zoom="close" aria-label="Close enlarged photo" title="Close enlarged photo"><i class="bx bx-x" aria-hidden="true"></i></button></div></div>
            <div class="rd-dialog-viewport"><img alt=""></div>
            <div class="rd-dialog-hints" aria-hidden="true">Use the zoom controls to enlarge the photo</div>`;
        const image = dialog.querySelector('img'), title = dialog.querySelector('[data-viewer-title]');
        const get = name => dialog.querySelector(`[data-zoom="${name}"]`);
        image.id = `${prefix}enlargedEvidence`; title.id = `${prefix}evidenceTitle`;
        for (const [name, id] of [['in', 'zoomIn'], ['out', 'zoomOut'], ['reset', 'resetZoom'], ['fullscreen', 'toggleFullscreen'], ['close', 'closeEvidence']]) {
            const el = get(name);
            if (el) el.id = prefix + id;
        }
        container.append(dialog);
        const zoom = new root.EvidenceZoom({ dialog, image, zoomIn: get('in'), zoomOut: get('out'), reset: get('reset') });
        let opener = null, source = null, revision = 0, destroyed = false;
        const listeners = [];
        function listen(target, event, callback) { target.addEventListener(event, callback); listeners.push(() => target.removeEventListener(event, callback)); }
        function updateFullscreenUI(isFs) {
            dialog.classList.toggle('is-fullscreen', isFs);
            const fsBtn = get('fullscreen');
            if (fsBtn) {
                fsBtn.setAttribute('title', isFs ? 'Exit full screen' : 'Full screen');
                fsBtn.setAttribute('aria-label', isFs ? 'Exit full screen' : 'Full screen');
                const icon = fsBtn.querySelector('i');
                if (icon) icon.className = isFs ? 'bx bx-exit-fullscreen' : 'bx bx-fullscreen';
            }
        }
        function toggleFullscreen() {
            const nextFs = !dialog.classList.contains('is-fullscreen');
            updateFullscreenUI(nextFs);
            try {
                if (nextFs) {
                    if (dialog.requestFullscreen && !document.fullscreenElement) {
                        dialog.requestFullscreen().catch(() => {});
                    }
                } else {
                    if (document.exitFullscreen && document.fullscreenElement) {
                        document.exitFullscreen().catch(() => {});
                    }
                }
            } catch {}
        }
        function close() { if (dialog.open) dialog.close(); }
        function closed() {
            revision++; zoom.reset(); image.removeAttribute('src'); source = null;
            updateFullscreenUI(false);
            if (document.fullscreenElement) {
                try { document.exitFullscreen().catch(() => {}); } catch {}
            }
            get('close').setAttribute('aria-label', 'Close enlarged photo');
            get('close').setAttribute('title', 'Close enlarged photo');
            if (opener?.isConnected && !destroyed) opener.focus({ preventScroll: true });
            opener = null;
        }
        function open(button) {
            const original = button?.querySelector('img');
            if (!original?.src || original.hidden || !original.complete || !original.naturalWidth) return;
            revision++; opener = button; source = original; zoom.reset();
            const isAction = button.matches('.rd-action-photo');
            title.textContent = isAction ? 'Action evidence' : `Photo ${button.dataset.photo}`;
            const closeLabel = isAction ? 'Close action photo' : 'Close enlarged photo';
            get('close').setAttribute('aria-label', closeLabel);
            get('close').setAttribute('title', closeLabel);
            image.alt = original.alt; image.src = original.src;
            if (!dialog.open) dialog.showModal();
            get('close').focus();
        }
        listen(container, 'click', event => { const button = event.target.closest('button.rd-photo, button.rd-action-photo'); if (button && container.contains(button)) open(button); });
        listen(get('close'), 'click', close);
        if (get('fullscreen')) listen(get('fullscreen'), 'click', toggleFullscreen);
        listen(document, 'fullscreenchange', () => {
            if (!dialog.open) return;
            const isDocFs = Boolean(document.fullscreenElement);
            if (!isDocFs && dialog.classList.contains('is-fullscreen')) {
                updateFullscreenUI(false);
            }
        });
        listen(dialog, 'close', closed);
        listen(dialog, 'cancel', event => { event.preventDefault(); event.stopPropagation(); close(); });
        listen(dialog, 'click', event => {
            if (event.target !== dialog) return;
            const bounds = dialog.getBoundingClientRect();
            if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) close();
        });
        listen(image, 'error', async () => {
            const version = revision, original = source;
            if (!original || !dialog.open) return;
            await root.ReportEvidence.renew(original);
            if (destroyed || version !== revision || source !== original) return;
            if (!original.hidden && original.src && original.src !== image.src) image.src = original.src;
            else close();
        });
        listen(root, 'session:changed', close);
        return { open, close, toggleFullscreen, destroy() { destroyed = true; revision++; close(); listeners.splice(0).forEach(remove => remove()); zoom.destroy(); image.removeAttribute('src'); dialog.remove(); opener = source = null; } };
    }
    root.EvidenceViewer = { mount };
})(window);
