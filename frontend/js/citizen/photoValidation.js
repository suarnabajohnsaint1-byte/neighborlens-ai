const CitizenPhotoValidation = (() => {
    function loadImageFile(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
                const image = new Image();
                image.onload = () => resolve(image);
                image.onerror = () => reject(new Error(`Could not read ${file.name || 'image'}.`));
                image.src = reader.result;
            };
            reader.onerror = () => reject(new Error(`Could not read ${file.name || 'image'}.`));
            reader.readAsDataURL(file);
        });
    }

    async function validateUploadedImage(file) {
        if (!file) return { valid: false, message: 'No file was selected.' };

        const allowedTypes = ['image/jpeg', 'image/png', 'image/webp'];
        if (!allowedTypes.includes(file.type) && !/\.(jpg|jpeg|png|webp)$/i.test(file.name || '')) {
            return { valid: false, message: 'Please upload a JPG, PNG, or WEBP image.' };
        }

        if (file.size <= 0) {
            return { valid: false, message: 'The selected file is empty.' };
        }

        const image = await loadImageFile(file);
        const minWidth = 96;
        const minHeight = 96;
        if (image.width < minWidth || image.height < minHeight) {
            return { valid: false, message: 'The image is too small. Upload a larger photo that clearly shows the issue.' };
        }

        const canvas = document.createElement('canvas');
        const maxSize = 1200;
        const scale = Math.min(1, maxSize / Math.max(image.width, image.height));
        canvas.width = Math.max(1, Math.round(image.width * scale));
        canvas.height = Math.max(1, Math.round(image.height * scale));

        const context = canvas.getContext('2d', { willReadFrequently: true });
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;

        let luminanceTotal = 0;
        let varianceSum = 0;
        const sampleCount = pixels.length / 4;

        for (let i = 0; i < pixels.length; i += 4) {
            const r = pixels[i];
            const g = pixels[i + 1];
            const b = pixels[i + 2];
            const lum = 0.299 * r + 0.587 * g + 0.114 * b;
            luminanceTotal += lum;
        }

        const mean = luminanceTotal / sampleCount;
        for (let i = 0; i < pixels.length; i += 4) {
            const lum = 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];
            varianceSum += (lum - mean) ** 2;
        }
        const variance = varianceSum / sampleCount;

        if (variance < 8 && (mean < 12 || mean > 245)) {
            return { valid: false, message: 'The image is almost completely blank or unreadable. Please provide a visible scene.' };
        }

        return { valid: true, image };
    }

    return { validateUploadedImage };
})();
