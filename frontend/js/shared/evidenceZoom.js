
(function (root) {
    'use strict';

    class EvidenceZoom {
        #scale = 1;
        #offsetX = 0;
        #offsetY = 0;
        #pointer = null;
        #pinch = null;
        #abortController = new AbortController();

        static MIN_SCALE = 1;
        static MAX_SCALE = 5;
        static STEP = 0.25;

        constructor({ dialog, image, zoomIn, zoomOut, reset }) {
            if (!dialog || !image) {
                throw new Error('EvidenceZoom requires a dialog and image.');
            }

            this.dialog = dialog;
            this.image = image;
            this.controls = { zoomIn, zoomOut, reset };

            const hints = dialog.querySelector?.('.rd-dialog-hints');
            const touch = root?.matchMedia?.('(pointer: coarse)');
            const updateHints = () => {
                if (hints) hints.textContent = touch?.matches
                    ? 'Pinch to zoom · Drag to move · Tap the percentage to reset'
                    : 'Scroll to zoom · Drag to move · Click the percentage to reset';
            };
            updateHints();
            touch?.addEventListener?.('change', updateHints, { signal: this.#abortController.signal });

            this.#bindEvents();
            this.#render();
        }

        get scale() {
            return this.#scale;
        }

        get offsetX() {
            return this.#offsetX;
        }

        get offsetY() {
            return this.#offsetY;
        }

        zoom(delta) {
            const numeric = Number(delta);
            if (!Number.isFinite(numeric)) return;
            this.setScale(this.#scale + numeric);
        }

        setScale(value, anchor, destination = anchor) {
            const numeric = Number(value);
            if (!Number.isFinite(numeric)) return;

            const next = Math.min(
                EvidenceZoom.MAX_SCALE,
                Math.max(EvidenceZoom.MIN_SCALE, numeric)
            );
            if (anchor && Number.isFinite(anchor.clientX) && Number.isFinite(anchor.clientY)) {
                const rect = this.image.getBoundingClientRect();
                const { width, height } = this.#imageSize();
                const clamp = (distance, halfSize) => Math.max(-halfSize, Math.min(halfSize, distance));
                const x = clamp(anchor.clientX - (rect.left + rect.width / 2), width * this.#scale / 2);
                const y = clamp(anchor.clientY - (rect.top + rect.height / 2), height * this.#scale / 2);
                const change = 1 - next / this.#scale;
                this.#offsetX += x * change + destination.clientX - anchor.clientX;
                this.#offsetY += y * change + destination.clientY - anchor.clientY;
            }
            this.#scale = next;

            this.#render();
        }

        reset() {
            this.#scale = 1;
            this.#offsetX = 0;
            this.#offsetY = 0;
            this.#pointer = null;
            this.#pinch = null;

            this.#render();
        }

        #imageSize() {
            const width = Number(this.image.clientWidth) || 0;
            const height = Number(this.image.clientHeight) || 0;
            const { naturalWidth, naturalHeight } = this.image;
            if (!naturalWidth || !naturalHeight) return { width, height };
            const fit = Math.min(width / naturalWidth, height / naturalHeight);
            return { width: naturalWidth * fit, height: naturalHeight * fit };
        }

        #constrain() {
            if (this.#scale <= 1) {
                this.#offsetX = 0;
                this.#offsetY = 0;
                return;
            }

            const { width, height } = this.#imageSize();

            const maxX = Math.max(0, width * (this.#scale - 1) / 2);
            const maxY = Math.max(0, height * (this.#scale - 1) / 2);

            this.#offsetX = Math.max(
                -maxX,
                Math.min(maxX, this.#offsetX)
            );

            this.#offsetY = Math.max(
                -maxY,
                Math.min(maxY, this.#offsetY)
            );
        }

        #render() {
            this.#constrain();

            this.image.style.transform =
                `translate(${this.#offsetX}px, ${this.#offsetY}px) scale(${this.#scale})`;

            this.image.style.cursor =
                this.#scale > 1 ? (this.#pointer ? 'grabbing' : 'grab') : 'zoom-in';

            const { zoomIn, zoomOut, reset } = this.controls;

            if (zoomIn) {
                zoomIn.disabled = this.#scale >= EvidenceZoom.MAX_SCALE;
            }

            if (zoomOut) {
                zoomOut.disabled = this.#scale <= EvidenceZoom.MIN_SCALE;
            }

            if (reset) {
                reset.textContent = `${Math.round(this.#scale * 100)}%`;
            }
        }

        #bindEvents() {
            const signal = this.#abortController.signal;
            const options = { signal };

            this.controls.zoomIn?.addEventListener(
                'click',
                () => this.zoom(EvidenceZoom.STEP),
                options
            );

            this.controls.zoomOut?.addEventListener(
                'click',
                () => this.zoom(-EvidenceZoom.STEP),
                options
            );

            this.controls.reset?.addEventListener(
                'click',
                () => this.reset(),
                options
            );

            const viewport = (typeof this.dialog.querySelector === 'function' ? this.dialog.querySelector('.rd-dialog-viewport') : null);
            const targets = [viewport || this.image];

            const onWheel = event => {
                if (!this.dialog.open) return;
                event.preventDefault();
                const delta = event.deltaY < 0 ? EvidenceZoom.STEP : -EvidenceZoom.STEP;
                this.setScale(this.#scale + delta, event);
            };

            const onPointerDown = event => {
                if (!this.dialog.open || this.#scale <= 1 || this.#pinch) return;
                if (!event.isPrimary) return;
                if (event.pointerType === 'mouse' && event.button !== 0) return;

                this.#pointer = {
                    id: event.pointerId,
                    x: event.clientX,
                    y: event.clientY
                };

                try {
                    const captureTarget = event.currentTarget || this.image;
                    captureTarget.setPointerCapture?.(event.pointerId);
                } catch {}
                this.#render();
            };

            const onPointerMove = event => {
                if (!this.#pointer || this.#pointer.id !== event.pointerId) return;

                this.#offsetX += event.clientX - this.#pointer.x;
                this.#offsetY += event.clientY - this.#pointer.y;

                this.#pointer.x = event.clientX;
                this.#pointer.y = event.clientY;

                this.#render();
            };

            const stopDragging = event => {
                if (this.#pointer?.id !== event.pointerId) return;
                try {
                    const captureTarget = event.currentTarget || this.image;
                    if (captureTarget.hasPointerCapture?.(event.pointerId)) {
                        captureTarget.releasePointerCapture(event.pointerId);
                    }
                } catch {}
                this.#pointer = null;
                this.#render();
            };

            const onDblClick = event => {
                if (!this.dialog.open) return;
                event.preventDefault();
                this.#scale > 1 ? this.reset() : this.setScale(2);
            };

            const updatePinch = event => {
                if (!this.dialog.open || event.touches.length !== 2) {
                    this.#pinch = null;
                    return;
                }
                event.preventDefault();
                const [a, b] = event.touches;
                const point = {
                    clientX: (a.clientX + b.clientX) / 2,
                    clientY: (a.clientY + b.clientY) / 2,
                    distance: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY)
                };
                const previous = this.#pinch;
                this.#pointer = null;
                this.#pinch = point;
                if (previous?.distance > 0) {
                    this.setScale(this.#scale * point.distance / previous.distance, previous, point);
                }
            };

            for (const t of targets) {
                t.addEventListener('wheel', onWheel, { passive: false, signal });
                t.addEventListener('pointerdown', onPointerDown, options);
                t.addEventListener('pointermove', onPointerMove, options);
                t.addEventListener('pointerup', stopDragging, options);
                t.addEventListener('pointercancel', stopDragging, options);
                t.addEventListener('dblclick', onDblClick, options);
                t.addEventListener('touchstart', updatePinch, { passive: false, signal });
                t.addEventListener('touchmove', updatePinch, { passive: false, signal });
                t.addEventListener('touchend', updatePinch, { passive: false, signal });
                t.addEventListener('touchcancel', () => { this.#pinch = null; }, options);
            }

            this.dialog.addEventListener(
                'close',
                () => this.reset(),
                options
            );

            this.dialog.ownerDocument.addEventListener('keydown', event => {
                if (!this.dialog.open) return;

                const target = event.target;
                if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;

                if (event.key === '+' || event.key === '=') {
                    event.preventDefault();
                    this.zoom(EvidenceZoom.STEP);
                } else if (event.key === '-') {
                    event.preventDefault();
                    this.zoom(-EvidenceZoom.STEP);
                } else if (event.key === '0') {
                    event.preventDefault();
                    this.reset();
                }
            }, options);
        }

        destroy() {
            this.#abortController.abort();
            this.reset();
        }
    }

    if (typeof module === 'object' && module.exports) {
        module.exports = EvidenceZoom;
    }

    if (root) {
        root.EvidenceZoom = EvidenceZoom;
    }
})(typeof window !== 'undefined' ? window : null);
