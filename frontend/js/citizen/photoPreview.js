const createCitizenPhotoPreview = (isCurrentUploadGeneration) => {
    let previewObjectUrls = [];

    function revokePreviewObjectUrls() {
        if (typeof URL === 'undefined' || typeof URL.revokeObjectURL !== 'function') {
            previewObjectUrls = [];
            return;
        }
        previewObjectUrls.forEach(url => {
            if (url) URL.revokeObjectURL(url);
        });
        previewObjectUrls = [];
    }

    function renderSelectedPreviews(files, generation) {
        const preview = document.getElementById('imgPreview');
        const preview2 = document.getElementById('imgPreview2');
        const grid = document.getElementById('imgPreviewGrid');
        const emptyState = document.getElementById('dropzoneEmptyState');
        const activeBar = document.getElementById('previewActiveBar');
        const tipsBox = document.getElementById('photoTipsBox');
        const uploadArea = document.getElementById('uploadArea');
        const countSpan = document.getElementById('previewAttachedCount');
        const retakeLabel = document.getElementById('retakePhotosLabel');

        const hasFiles = Boolean(files && files.length > 0);
        if (retakeLabel) retakeLabel.textContent = files.length === 1 ? 'Take second photo' : 'Retake photos';

        if (emptyState) {
            emptyState.style.display = hasFiles ? 'none' : '';
        }
        if (activeBar) {
            activeBar.style.display = hasFiles ? 'flex' : 'none';
            if (countSpan) {
                countSpan.textContent = `${files.length} of 2 photos attached`;
            }
        }
        const frame1 = document.getElementById('previewFrame1');
        const frame2 = document.getElementById('previewFrame2');
        if (frame1) frame1.style.display = files && files[0] ? 'block' : 'none';
        if (frame2) frame2.style.display = files && files[1] ? 'block' : 'none';
        if (tipsBox) {
            tipsBox.style.display = hasFiles ? 'none' : 'block';
        }
        if (uploadArea && uploadArea.classList) {
            if (hasFiles && typeof uploadArea.classList.add === 'function') {
                uploadArea.classList.add('has-previews');
            } else if (!hasFiles && typeof uploadArea.classList.remove === 'function') {
                uploadArea.classList.remove('has-previews');
            }
        }
        const stepCard = document.getElementById('stepPhotosCard');
        if (stepCard && stepCard.classList) {
            if (hasFiles && typeof stepCard.classList.add === 'function') {
                stepCard.classList.add('has-attached-photos');
            } else if (!hasFiles && typeof stepCard.classList.remove === 'function') {
                stepCard.classList.remove('has-attached-photos');
            }
        }
        if (grid) {
            grid.style.display = hasFiles ? 'grid' : 'none';
        }
        revokePreviewObjectUrls();
        const previews = [preview, preview2];

        previews.forEach((img, index) => {
            const file = files[index];
            const frame = index === 0 ? frame1 : frame2;
            if (!img) return;
            img.onload = null;
            img.onerror = null;
            if (!file) {
                img.src = '';
                img.style.display = 'none';
                frame?.classList?.remove('nl-image-loading', 'nl-image-loaded');
                img.classList?.remove('nl-img-loading', 'nl-img-loaded');
                return;
            }
            frame?.classList?.remove('nl-image-loaded');
            frame?.classList?.add('nl-image-loading');
            img.classList?.remove('nl-img-loaded');
            img.classList?.add('nl-img-loading');
            const stopLoading = () => {
                if (!isCurrentUploadGeneration(generation)) return;
                frame?.classList?.remove('nl-image-loading');
                img.classList?.remove('nl-img-loading');
            };
            const onLoaded = () => {
                if (!isCurrentUploadGeneration(generation)) return;
                stopLoading();
                frame?.classList?.add('nl-image-loaded');
                img.classList?.add('nl-img-loaded');
            };
            img.onload = onLoaded;
            img.onerror = stopLoading;
            img.style.display = 'block';
            if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
                const url = URL.createObjectURL(file);
                previewObjectUrls[index] = url;
                img.src = url;
                return;
            }
            const reader = new FileReader();
            reader.onload = e => {
                if (!isCurrentUploadGeneration(generation)) return;
                img.src = e.target.result;
                img.style.display = 'block';
            };
            reader.onerror = stopLoading;
            reader.readAsDataURL(file);
        });
    }

    return { renderSelectedPreviews, revokePreviewObjectUrls };
};
