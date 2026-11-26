(() => {
    const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
    const closeTo = (a, b) => Math.abs(a - b) < 1e-6;

    function zoomAt(value, { min, max, step }) {
        const bounded = clamp(value, min, max);
        if (!(step > 0)) return bounded;
        const lastStep = Math.floor((max - min) / step + 1e-6);
        const offset = Math.min(lastStep, Math.round((bounded - min) / step));
        return clamp(Number((min + offset * step).toPrecision(12)), min, max);
    }

    function mount(dialog, video) {
        const group = dialog.querySelector('[data-camera-zoom-controls]');
        const buttons = [...group.querySelectorAll('[data-camera-zoom]')];
        const level = group.querySelector('[data-camera-zoom-level]');
        const reticle = dialog.querySelector('[data-camera-focus]');
        const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
        const pointers = new Map();
        let connection;
        let pinch;
        let focusTimer;

        function renderZoom() {
            group.hidden = !connection?.range;
            if (group.hidden) return;
            const { zoom, presets } = connection;
            buttons.forEach((button, index) => {
                const preset = presets[index];
                button.hidden = preset === undefined;
                if (button.hidden) return;
                button.dataset.cameraZoom = preset;
                button.textContent = `${Number(preset.toFixed(2))}×`;
                button.setAttribute('aria-label', `${Number(preset.toFixed(2))}× zoom`);
                button.setAttribute('aria-pressed', String(closeTo(zoom, preset)));
            });
            level.hidden = presets.some(value => closeTo(value, zoom));
            level.textContent = `${Number(zoom.toFixed(2))}×`;
        }

        function disconnect() {
            connection = undefined;
            pointers.clear();
            pinch = undefined;
            clearTimeout(focusTimer);
            reticle.hidden = true;
            renderZoom();
        }

        function connect(track) {
            disconnect();
            if (!track?.applyConstraints) return;
            let capabilities, settings, base;
            try {
                capabilities = track.getCapabilities?.() || {};
                settings = track.getSettings();
                base = track.getConstraints?.() || {};
            } catch {
                return;
            }
            const supported = navigator.mediaDevices.getSupportedConstraints?.() || {};
            const range = capabilities.zoom;
            const zoomSupported = [range?.min, range?.max, settings.zoom].every(Number.isFinite) && range.min > 0 && range.max > range.min;
            const modes = capabilities.focusMode || [];
            const focusMode = supported.pointsOfInterest && (modes.includes('continuous') ? 'continuous' : modes.includes('single-shot') ? 'single-shot' : null);
            const presets = zoomSupported ? [...new Set([
                ...[1, 2].filter(value => closeTo(zoomAt(value, range), value)), range.min, zoomAt(range.max, range)
            ])].slice(0, 2).sort((a, b) => a - b) : [];
            connection = { track, base, range: zoomSupported ? range : null,
                zoom: settings.zoom, presets, focusMode, nextZoom: null, nextFocus: null, applying: false };
            renderZoom();
        }

        function showFocus({ x, y }) {
            clearTimeout(focusTimer);
            reticle.style.left = `${x}px`;
            reticle.style.top = `${y}px`;
            reticle.hidden = false;
            if (!reducedMotion.matches) {
                reticle.getAnimations?.().forEach(animation => animation.cancel());
                reticle.animate?.([{ opacity: 0.3, scale: 1.15 }, { opacity: 1, scale: 1 }], { duration: 160, easing: 'ease-out' });
            }
            focusTimer = setTimeout(() => { reticle.hidden = true; }, 520);
        }

        async function applyPending(current) {
            if (current.applying) return;
            current.applying = true;
            while (connection === current && (current.nextZoom !== null || current.nextFocus)) {
                const zoom = current.nextZoom;
                const focus = zoom === null ? current.nextFocus : null;
                current.nextZoom = null;
                if (focus) current.nextFocus = null;
                const settings = current.range ? { zoom: zoom ?? current.zoom } : {};
                if (focus) Object.assign(settings, { focusMode: current.focusMode, pointsOfInterest: [focus.point] });
                try {
                    await current.track.applyConstraints({ ...current.base, advanced: [...(current.base.advanced || []), settings] });
                    if (connection !== current) return;
                    const actual = current.track.getSettings();
                    if (zoom !== null && (!Number.isFinite(actual.zoom) || (closeTo(actual.zoom, current.zoom) && !closeTo(zoom, actual.zoom)))) {
                        current.range = null;
                        current.nextZoom = null;
                    } else if (Number.isFinite(actual.zoom)) {
                        current.zoom = actual.zoom;
                    }
                    if (focus && actual.pointsOfInterest?.some(point => Math.abs(point.x - focus.point.x) < 0.02 && Math.abs(point.y - focus.point.y) < 0.02)) showFocus(focus);
                } catch {
                    if (connection !== current) return;
                    if (zoom !== null) {
                        current.range = null;
                        current.nextZoom = null;
                    }
                }
                renderZoom();
            }
            current.applying = false;
        }

        function setZoom(value) {
            const current = connection;
            if (!current?.range) return;
            current.nextZoom = zoomAt(value, current.range);
            applyPending(current);
        }

        function focusAt(event) {
            const current = connection;
            if (!current?.focusMode || !video.videoWidth || !video.videoHeight) return;
            const bounds = video.getBoundingClientRect();
            const scale = Math.max(bounds.width / video.videoWidth, bounds.height / video.videoHeight);
            const width = video.videoWidth * scale;
            const height = video.videoHeight * scale;
            const x = event.clientX - bounds.left;
            const y = event.clientY - bounds.top;
            current.nextFocus = { x, y, point: {
                x: clamp((x + (width - bounds.width) / 2) / width, 0, 1),
                y: clamp((y + (height - bounds.height) / 2) / height, 0, 1)
            } };
            applyPending(current);
        }

        function distance() {
            const [a, b] = pointers.values();
            return Math.hypot(a.x - b.x, a.y - b.y);
        }

        video.addEventListener('pointerdown', event => {
            if ((!connection?.range && !connection?.focusMode) || event.button !== 0) return;
            const { clientX: x, clientY: y } = event;
            pointers.set(event.pointerId, { x, y, startX: x, startY: y, tap: pointers.size === 0 });
            video.setPointerCapture(event.pointerId);
            if (pointers.size > 1) {
                pointers.forEach(pointer => { pointer.tap = false; });
                pinch = pointers.size === 2 && connection.range && { distance: Math.max(1, distance()), zoom: connection.nextZoom ?? connection.zoom };
            }
        });
        video.addEventListener('pointermove', event => {
            const pointer = pointers.get(event.pointerId);
            if (!pointer) return;
            pointer.x = event.clientX;
            pointer.y = event.clientY;
            if (Math.hypot(pointer.x - pointer.startX, pointer.y - pointer.startY) > 8) pointer.tap = false;
            if (pinch) setZoom(pinch.zoom * distance() / pinch.distance);
        });
        function endPointer(event) {
            const pointer = pointers.get(event.pointerId);
            if (!pointer) return;
            pointers.delete(event.pointerId);
            pinch = undefined;
            if (event.type === 'pointerup' && pointer.tap) focusAt(event);
        }
        for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) video.addEventListener(type, endPointer);
        buttons.forEach(button => button.addEventListener('click', () => setZoom(Number(button.dataset.cameraZoom))));
        return { connect, disconnect };
    }

    window.ReportCameraControls = { mount };
})();
