const createCitizenLandmarkField = ({
    container,
    onChange = () => { },
    onCapture = () => { },
    onPreview = () => { }
}) => {
    const TEMPLATE_PATH = 'components/citizen/landmark-field.html';

    let mounted = false;
    let photo = null;
    let previewUrl = null;

    const find = selector => container.querySelector(selector);

    async function render() {
        const response = await fetch(TEMPLATE_PATH);

        if (!response.ok) {
            throw new Error(
                `Failed to load landmark field: ${response.status}`
            );
        }

        container.innerHTML = await response.text();
    }

    function updateCounter() {
        const description = find('#landmarkDescription');
        const counter = find('#landmarkCharCounter');

        counter.textContent =
            `${description.value.length}/${description.maxLength}`;
    }

    function getDescription() {
        return find('#landmarkDescription')?.value.trim() || '';
    }

    function getPhoto() {
        return photo;
    }

    function releasePreview() {
        if (!previewUrl) return;

        URL.revokeObjectURL(previewUrl);
        previewUrl = null;
    }

    function setPhoto(file) {
        if (!mounted) {
            throw new Error('Landmark field is not mounted.');
        }

        if (!(file instanceof File) || file.size === 0) {
            throw new Error('Invalid landmark photo.');
        }

        releasePreview();

        photo = file;
        previewUrl = URL.createObjectURL(file);

        find('#landmarkPreview').src = previewUrl;
        find('#landmarkPreviewBtn').hidden = false;
        find('#landmarkCameraLabel').textContent = 'Retake';

        container.dataset.captured = 'true';

        onChange();
    }

    function isComplete() {
        if (!mounted) return false;

        const input = find('#landmarkDescription');
        const description = getDescription();

        return photo !== null
            && description.length > 0
            && input.value.length <= input.maxLength;
    }

    function bind() {
        find('.citizen-landmark-composer').addEventListener('click', event => {
            if (event.target.closest('button, textarea')) return;

            find('#landmarkDescription').focus();
        });

        find('#landmarkDescription').addEventListener('input', () => {
            updateCounter();
            onChange();
        });

        find('#landmarkCameraBtn').addEventListener('click', () => {
            onCapture();
        });

        find('#landmarkPreviewBtn').addEventListener('click', () => {
            if (previewUrl) {
                onPreview(previewUrl);
            }
        });
    }

    async function mount() {
        if (!container) {
            throw new Error('Landmark container not found.');
        }

        if (mounted) return;

        await render();

        bind();
        updateCounter();

        container.dataset.captured = 'false';
        mounted = true;
    }

    function reset() {
        if (!mounted) return;

        releasePreview();

        photo = null;

        find('#landmarkDescription').value = '';
        find('#landmarkPreview').removeAttribute('src');
        find('#landmarkPreviewBtn').hidden = true;
        find('#landmarkCameraLabel').textContent = 'Take photo';

        container.dataset.captured = 'false';

        updateCounter();
        onChange();
    }

    function destroy() {
        releasePreview();

        photo = null;

        if (container) {
            container.replaceChildren();
            delete container.dataset.captured;
        }

        mounted = false;
    }

    return {
        mount,
        getDescription,
        getPhoto,
        setPhoto,
        isComplete,
        reset,
        destroy
    };
};