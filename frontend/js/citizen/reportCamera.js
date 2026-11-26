(() => {
    const damageInstructions = [
        'Photo 1 of 2 · Take a close-up',
        'Photo 2 of 2 · Move to another angle'
    ];

    const landmarkInstruction = 'Landmark photo · Show the issue and surrounding area';

    function mount(dialog, onPhotos, getPhotos = () => []) {
        const find = selector => dialog.querySelector(selector);
        const video = find('video');
        const shutter = find('[data-camera-capture]');
        const closeButton = find('[data-camera-close]');
        const flip = find('[data-camera-flip]');
        const retry = find('[data-camera-retry]');
        const status = find('[data-camera-status]');
        const flash = find('[data-camera-flash]');
        const flight = find('[data-camera-flight]');
        const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
        const controls = window.ReportCameraControls.mount(dialog, video);
        const thumbnails = [...dialog.querySelectorAll('[data-camera-photo]')];
        const photos = [null, null];
        const previews = [null, null];
        let step = 0;
        let generation = 0;
        let stream;
        let ready = false;
        let busy = false;
        let cameraId;
        let facingMode;
        let cameras = [];
        let captureEffects = [];
        let landmarkMode = false;
        let landmarkOnCapture = null;

        const stopTracks = source => source?.getTracks().forEach(track => track.stop());
        const isCurrent = request => dialog.open && request === generation;

        function stopPreview() {
            ready = false;
            controls.disconnect();
            stopTracks(stream);
            stream = undefined;
            video.srcObject = null;
        }

        function feedback(message = '', canRetry = false) {
            status.textContent = message;
            status.parentElement.hidden = !message;
            retry.hidden = !canRetry;
        }

        function selectStep(index) {
            step = index;
            find('[data-camera-step]').textContent = landmarkMode
                ? landmarkInstruction
                : damageInstructions[index];
            shutter.setAttribute('aria-label', landmarkMode
                ? 'Capture landmark photo'
                : `Capture photo ${index + 1}`);
            thumbnails.forEach((button, position) => {
                if (!landmarkMode && position === index) button.setAttribute('aria-current', 'step');
                else button.removeAttribute('aria-current');
            });
        }

        function showPhoto(index, file) {
            const url = file ? URL.createObjectURL(file) : null;
            if (previews[index]) URL.revokeObjectURL(previews[index]);
            photos[index] = file;
            previews[index] = url;
            const button = thumbnails[index];
            const img = button.querySelector('img');
            if (file) img.src = previews[index];
            else img.removeAttribute('src');
            img.hidden = !file;
            button.querySelector('span').hidden = Boolean(file);
            button.disabled = !file;
        }

        function setLandmarkUi(active) {
            thumbnails.forEach(button => {
                button.hidden = active;
            });
        }

        function close() {
            generation++;
            stopPreview();
            clearCaptureEffects();
            busy = false;
            flip.disabled = false;
            photos.forEach((_, index) => showPhoto(index, null));
            if (landmarkMode) {
                landmarkMode = false;
                landmarkOnCapture = null;
                setLandmarkUi(false);
            }
            if (dialog.open) dialog.close();
        }

        async function startPreview() {
            const request = ++generation;
            stopPreview();
            clearCaptureEffects();
            busy = false;
            shutter.disabled = true;
            flip.disabled = false;
            flip.hidden = true;
            feedback('Starting camera…');
            const devices = navigator.mediaDevices;
            if (!devices?.getUserMedia) {
                feedback('Camera unavailable. Open the portal on HTTPS or localhost to use your camera.');
                return;
            }

            try {
                const constraints = {
                    ...(cameraId ? { deviceId: { exact: cameraId } } : { facingMode: { ideal: 'environment' } }),
                    width: { ideal: 1920 }, height: { ideal: 1080 }
                };
                const zoom = devices.getSupportedConstraints?.()?.zoom;
                let source;
                try {
                    source = await devices.getUserMedia({ audio: false, video: zoom ? { ...constraints, zoom: true } : constraints });
                } catch (error) {
                    if (!isCurrent(request)) return;
                    if (!zoom || !['NotAllowedError', 'OverconstrainedError', 'SecurityError'].includes(error.name)) throw error;
                    source = await devices.getUserMedia({ audio: false, video: constraints });
                }
                if (!isCurrent(request)) {
                    stopTracks(source);
                    return;
                }
                stream = source;
                video.srcObject = source;
                await video.play();
                if (!isCurrent(request)) return;
                ready = true;
                shutter.disabled = false;
                feedback();
                const track = source.getVideoTracks()[0];
                const settings = track?.getSettings() || {};
                cameraId = settings.deviceId || cameraId;
                facingMode = settings.facingMode;
                controls.connect(track);
                track?.addEventListener('ended', () => {
                    if (!isCurrent(request)) return;
                    stopPreview();
                    shutter.disabled = true;
                    flip.hidden = true;
                    feedback('Camera disconnected. Try again to continue.', true);
                }, { once: true });
            } catch (error) {
                if (!isCurrent(request)) return;
                stopPreview();
                feedback(error.name === 'NotAllowedError'
                    ? 'Allow camera access in your browser, then try again.'
                    : 'Could not start the camera. Check that it is connected and available.', true);
                return;
            }

            const available = await devices.enumerateDevices?.().catch(() => []);
            if (isCurrent(request) && ready) {
                cameras = (available ?? []).filter(device => device.kind === 'videoinput' && device.deviceId);
                flip.hidden = cameras.length < 2;
            }
        }

        function open(event) {
            if (dialog.open) return;
            landmarkMode = false;
            landmarkOnCapture = null;
            setLandmarkUi(false);
            cameraId = undefined;
            facingMode = undefined;
            const saved = getPhotos();
            const retakePair = event.currentTarget.hasAttribute('data-camera-retake-pair') && saved[0] && saved[1];
            photos.forEach((_, index) => showPhoto(index, retakePair ? null : saved[index] || null));
            selectStep(photos[0] && !photos[1] ? 1 : 0);
            dialog.showModal();
            startPreview();
        }

        function openLandmark(onCapture) {
            if (dialog.open) return;
            if (typeof onCapture !== 'function') throw new Error('openLandmark requires an onCapture callback.');
            landmarkMode = true;
            landmarkOnCapture = onCapture;
            cameraId = undefined;
            facingMode = undefined;
            setLandmarkUi(true);
            selectStep(0);
            dialog.showModal();
            startPreview();
        }

        function captureFrame() {
            const canvas = document.createElement('canvas');
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            canvas.getContext('2d').drawImage(video, 0, 0);
            return new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.95));
        }

        function clearCaptureEffects() {
            captureEffects.forEach(effect => effect.cancel());
            captureEffects = [];
            flight.hidden = true;
            flight.removeAttribute('src');
        }

        async function animateLandmarkCapture() {
            try { navigator.vibrate?.(12); } catch { }
            if (reducedMotion.matches || !flash.animate) return;
            captureEffects = [
                flash.animate([{ opacity: .82 }, { opacity: 0 }], { duration: 180, easing: 'ease-out' }),
                shutter.animate([{ transform: 'scale(.94)' }, { transform: 'scale(1)' }], { duration: 170, easing: 'ease-out' })
            ];
            await Promise.allSettled(captureEffects.map(effect => effect.finished));
        }

        async function animateCapture(index) {
            try { navigator.vibrate?.(12); } catch { }
            if (reducedMotion.matches || !flash.animate) return;
            const slot = thumbnails[index].getBoundingClientRect();
            const stage = dialog.getBoundingClientRect();
            const left = slot.left - stage.left, top = slot.top - stage.top;
            Object.assign(flight.style, { left: `${left}px`, top: `${top}px`, width: `${slot.width}px`, height: `${slot.height}px` });
            flight.src = previews[index];
            flight.hidden = false;
            captureEffects = [
                flash.animate([{ opacity: .82 }, { opacity: 0 }], { duration: 180, easing: 'ease-out' }),
                shutter.animate([{ transform: 'scale(.94)' }, { transform: 'scale(1)' }], { duration: 170, easing: 'ease-out' }),
                flight.animate([
                    { transform: `translate(${stage.width / 2 - left - slot.width / 2}px, ${stage.height / 2 - top - slot.height / 2}px) scale(2)`, opacity: .9 },
                    { transform: 'none', opacity: 1 }
                ], { duration: 220, easing: 'cubic-bezier(.2,.7,.2,1)' })
            ];
            await Promise.allSettled(captureEffects.map(effect => effect.finished));
        }

        async function capture() {
            if (!ready || busy || !video.videoWidth || !video.videoHeight) return;
            const request = generation;
            const index = step;
            busy = true;
            shutter.disabled = true;
            flip.disabled = true;
            let files;
            let landmarkFile;
            try {
                const blob = await captureFrame();
                if (!isCurrent(request) || !ready) return;
                if (!blob) throw new Error('Empty camera capture');

                if (landmarkMode) {
                    landmarkFile = new File([blob], `landmark_${Date.now()}.jpg`, { type: blob.type || 'image/jpeg' });
                    feedback();
                    await animateLandmarkCapture();
                } else {
                    showPhoto(index, new File([blob], `damage_angle_${index + 1}_${Date.now()}.jpg`, { type: blob.type || 'image/jpeg' }));
                    feedback();
                    await animateCapture(index);
                    if (!isCurrent(request)) return;
                    const next = photos.findIndex(photo => !photo);
                    if (next >= 0) selectStep(next);
                    else files = photos.slice();
                }
            } catch {
                if (isCurrent(request)) feedback('Could not capture this photo. Tap the shutter to try again.');
                return;
            } finally {
                if (isCurrent(request)) {
                    clearCaptureEffects();
                    busy = false;
                    shutter.disabled = !ready;
                    flip.disabled = false;
                }
            }

            if (landmarkFile && isCurrent(request)) {
                const callback = landmarkOnCapture;
                close();
                if (typeof callback === 'function') callback(landmarkFile);
            } else if (files) {
                close();
                await onPhotos(files);
            }
        }

        document.querySelectorAll('[data-report-camera]').forEach(button => button.addEventListener('click', open));
        closeButton.addEventListener('click', close);
        dialog.addEventListener('cancel', event => {
            event.preventDefault();
            close();
        });
        shutter.addEventListener('click', capture);
        retry.addEventListener('click', startPreview);
        flip.addEventListener('click', () => {
            if (busy || !ready) return;
            const current = cameras.findIndex(device => device.deviceId === cameraId);
            const opposite = facingMode === 'environment' ? /front|facetime/i : facingMode === 'user' ? /back|rear/i : null;
            const next = (opposite && cameras.find(device => device.deviceId !== cameraId && opposite.test(device.label))) || cameras[(current + 1) % cameras.length];
            if (!next) return;
            cameraId = next.deviceId;
            startPreview();
        });
        thumbnails.forEach((button, index) => button.addEventListener('click', () => {
            if (ready && !busy && !landmarkMode) selectStep(index);
        }));
        window.addEventListener('pagehide', close);
        window.addEventListener('citizen:section-changed', () => {
            if (document.body.dataset.citizenSection !== 'submitSection') close();
        });
        return { close, openLandmark };
    }

    window.ReportCamera = { mount };
})();
