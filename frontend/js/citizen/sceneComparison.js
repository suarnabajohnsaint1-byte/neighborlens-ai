// This correlation is advisory. The pair assessor owns evidence verification.
const CitizenSceneComparison = (() => {
    function comparePhotoScenes(images) {
        const vectors = images.map(image => {
            const canvas = document.createElement('canvas');
            canvas.width = 32;
            canvas.height = 32;
            const context = canvas.getContext('2d', { willReadFrequently: true });
            context.drawImage(image, 0, 0, 32, 32);
            const pixels = context.getImageData(0, 0, 32, 32).data;
            const values = [];
            for (let index = 0; index < pixels.length; index += 4) {
                values.push((0.299 * pixels[index] + 0.587 * pixels[index + 1] + 0.114 * pixels[index + 2]) / 255);
            }
            const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
            const centered = values.map(value => value - mean);
            const norm = Math.sqrt(centered.reduce((sum, value) => sum + value * value, 0));
            return { centered, norm };
        });

        return compareSceneVectors(vectors[0], vectors[1]);
    }

    function compareSceneVectors(first, second) {
        const method = 'grayscale_correlation';
        if (!first?.centered?.length || first.centered.length !== second?.centered?.length ||
            !Number.isFinite(first.norm) || !Number.isFinite(second.norm) || first.norm <= 0 || second.norm <= 0 ||
            !first.centered.every(Number.isFinite) || !second.centered.every(Number.isFinite)) {
            return { matched: null, score: null, threshold: 82, method, status: 'UNAVAILABLE' };
        }
        const similarity = first.centered.reduce((sum, value, index) => sum + value * second.centered[index], 0) / (first.norm * second.norm);
        const score = Math.round(Math.max(0, Math.min(1, similarity)) * 100);
        return { matched: score >= 82, score, threshold: 82, method, status: 'AVAILABLE' };
    }

    return { comparePhotoScenes, compareSceneVectors };
})();
