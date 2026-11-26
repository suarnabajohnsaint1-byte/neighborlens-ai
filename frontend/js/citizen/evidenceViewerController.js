const createCitizenEvidenceViewer = ({ getAssessment, describeAssessmentPhoto, overlay, Zoom }) => {
    function previewElements() {
        return ['imgPreview', 'imgPreview2'].map(id => document.getElementById(id));
    }
    let evidenceZoom = null;
    let overlayObserver = null;

    function updateCitizenFullscreenUI(isFs) {
        const dialog = document.getElementById('citizenEvidenceDialog');
        if (!dialog) return;
        if (dialog.classList?.toggle) {
            dialog.classList.toggle('is-fullscreen', isFs);
        }
        const fsBtn = document.getElementById('citizenToggleFullscreen');
        if (fsBtn) {
            if (typeof fsBtn.setAttribute === 'function') {
                fsBtn.setAttribute('title', isFs ? 'Exit full screen' : 'Full screen');
                fsBtn.setAttribute('aria-label', isFs ? 'Exit full screen' : 'Full screen');
            }
            const icon = typeof fsBtn.querySelector === 'function' ? fsBtn.querySelector('i') : null;
            if (icon) icon.className = isFs ? 'bx bx-exit-fullscreen' : 'bx bx-fullscreen';
        }
    }

    function toggleCitizenFullscreen() {
        const dialog = document.getElementById('citizenEvidenceDialog');
        if (!dialog) return;
        const isFs = dialog.classList?.contains ? dialog.classList.contains('is-fullscreen') : false;
        const nextFs = !isFs;
        updateCitizenFullscreenUI(nextFs);
        try {
            if (nextFs) {
                if (dialog.requestFullscreen && !document.fullscreenElement) {
                    dialog.requestFullscreen().catch(() => { });
                }
            } else {
                if (document.exitFullscreen && document.fullscreenElement === dialog) {
                    document.exitFullscreen().catch(() => { });
                }
            }
        } catch { }
    }

    function openCitizenPhotoZoom(index) {
        const previewImg = index === 0 ? document.getElementById('imgPreview') : document.getElementById('imgPreview2');
        if (!previewImg || !previewImg.src || previewImg.style.display === 'none') return;

        const dialog = document.getElementById('citizenEvidenceDialog');
        const enlargedImg = document.getElementById('citizenEnlargedEvidence');
        const title = document.getElementById('citizenEvidenceTitle');
        const subtitle = document.getElementById('citizenEvidenceSubtitle');
        if (!dialog || !enlargedImg) return;

        enlargedImg.src = previewImg.src;
        enlargedImg.alt = `Photo ${index + 1} evidence enlarged`;
        if (title) title.textContent = `Photo ${index + 1}`;

        const assessment = getAssessment();
        const photo = assessment?.photos?.[index];
        if (subtitle) {
            subtitle.textContent = photo?.state ? describeAssessmentPhoto(assessment, photo) : 'Attached photo evidence';
        }

        if (typeof dialog.showModal === 'function') {
            try {
                if (!dialog.open) dialog.showModal();
            } catch { }
        }

        if (Zoom) {
            if (!evidenceZoom) {
                try {
                    evidenceZoom = new Zoom({
                        dialog,
                        image: enlargedImg,
                        zoomIn: document.getElementById('citizenZoomIn'),
                        zoomOut: document.getElementById('citizenZoomOut'),
                        reset: document.getElementById('citizenResetZoom')
                    });
                } catch (err) {
                    console.warn('[citizen] EvidenceZoom init warning:', err);
                }
            } else {
                evidenceZoom.reset();
            }
        }

        if (overlay) {
            overlay.clear(enlargedImg);
            if (photo?.previewBoxes?.length) {
                overlay.render(enlargedImg, photo.previewBoxes, photo.imageSize);
            }
        }

        if (overlayObserver) {
            overlayObserver.disconnect();
            overlayObserver = null;
        }
        const viewport = enlargedImg.parentElement;
        const syncTransform = () => {
            const overlayElement = viewport?.querySelector(':scope > .detection-overlay');
            if (overlayElement) {
                overlayElement.style.transform = enlargedImg.style.transform;
                overlayElement.style.transformOrigin = 'center center';
            }
        };
        syncTransform();
        if (typeof MutationObserver !== 'undefined') {
            overlayObserver = new MutationObserver(syncTransform);
            overlayObserver.observe(enlargedImg, { attributes: true, attributeFilter: ['style'] });
            if (viewport) overlayObserver.observe(viewport, { childList: true });
        }
    }

    function closeCitizenPhotoZoom() {
        const dialog = document.getElementById('citizenEvidenceDialog');
        const enlargedImg = document.getElementById('citizenEnlargedEvidence');

        if (overlayObserver) {
            overlayObserver.disconnect();
            overlayObserver = null;
        }

        if (enlargedImg && overlay) {
            overlay.clear(enlargedImg);
        }

        if (evidenceZoom) {
            evidenceZoom.destroy();
            evidenceZoom = null;
        }

        updateCitizenFullscreenUI(false);
        if (dialog && document.fullscreenElement === dialog) {
            try { document.exitFullscreen().catch(() => { }); } catch { }
        }

        if (enlargedImg) enlargedImg.removeAttribute?.('src');

        if (dialog && typeof dialog.close === 'function' && dialog.open) {
            dialog.close();
        }
    }

    function renderDetectionOverlays(result) {
        if (!overlay) return;
        previewElements().forEach((img, index) => {
            const photo = result?.photos?.[index];
            if (img && photo) overlay.render(img, photo.previewBoxes, photo.imageSize);
        });

        const dialog = document.getElementById('citizenEvidenceDialog');
        const enlargedImg = document.getElementById('citizenEnlargedEvidence');
        if (dialog && dialog.open && enlargedImg && enlargedImg.src) {
            const preview0 = document.getElementById('imgPreview');
            const preview1 = document.getElementById('imgPreview2');
            let activeIdx = -1;
            if (preview0 && enlargedImg.src === preview0.src) activeIdx = 0;
            else if (preview1 && enlargedImg.src === preview1.src) activeIdx = 1;
            if (activeIdx !== -1) {
                const photo = result?.photos?.[activeIdx];
                if (photo) {
                    overlay.render(enlargedImg, photo.previewBoxes, photo.imageSize);
                }
            }
        }
    }

    function clearDetectionOverlays() {
        if (!overlay) return;
        previewElements().forEach(img => overlay.clear(img));
        const enlargedImg = document.getElementById('citizenEnlargedEvidence');
        if (enlargedImg) overlay.clear(enlargedImg);
    }

    function bind() {
        const citizenDialog = document.getElementById('citizenEvidenceDialog');
        if (citizenDialog && !citizenDialog.__bound) {
            citizenDialog.__bound = true;
            citizenDialog.addEventListener('click', (e) => {
                if (e.target !== citizenDialog) return;
                if (typeof citizenDialog.getBoundingClientRect === 'function') {
                    const bounds = citizenDialog.getBoundingClientRect();
                    if (e.clientX < bounds.left || e.clientX > bounds.right || e.clientY < bounds.top || e.clientY > bounds.bottom) {
                        closeCitizenPhotoZoom();
                    }
                } else {
                    closeCitizenPhotoZoom();
                }
            });
            citizenDialog.addEventListener('cancel', (e) => {
                if (typeof e.preventDefault === 'function') e.preventDefault();
                closeCitizenPhotoZoom();
            });
            citizenDialog.addEventListener('close', () => {
                if (!citizenDialog.open && (overlayObserver || evidenceZoom)) closeCitizenPhotoZoom();
            });
            const fsBtn = document.getElementById('citizenToggleFullscreen');
            if (fsBtn) {
                fsBtn.addEventListener('click', toggleCitizenFullscreen);
            }
            if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
                document.addEventListener('fullscreenchange', () => {
                    if (!citizenDialog.open) return;
                    const isDocFs = Boolean(document.fullscreenElement);
                    if (!isDocFs && citizenDialog.classList?.contains && citizenDialog.classList.contains('is-fullscreen')) {
                        updateCitizenFullscreenUI(false);
                    }
                });
            }
        }
    }

    return { bind, openCitizenPhotoZoom, closeCitizenPhotoZoom, toggleCitizenFullscreen, renderDetectionOverlays, clearDetectionOverlays };
};
