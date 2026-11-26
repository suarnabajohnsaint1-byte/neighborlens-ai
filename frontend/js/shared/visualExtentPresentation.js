(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.VisualExtentPresentation = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const unavailable = {
        INVALID_CROP: 'Too little image detail inside the detection.',
        INSUFFICIENT_CONTRAST: 'Too little contrast to separate the damage.',
        INSUFFICIENT_DETAIL: 'Too little detail to measure a region.',
        NO_SEPARABLE_REGION: 'No distinct candidate region was found.'
    };
    const number = value => Number.isFinite(value) ? value.toLocaleString('en-US', { maximumFractionDigits: 1 }) : '—';

    function describe(item) {
        if (item.quality !== 'EXPERIMENTAL') return unavailable[item.reason] || 'Visual measurement unavailable.';
        const f = item.features;
        if (!f) return 'Visual measurement unavailable.';
        switch (item.category) {
            case 'road_crack':
                return `Crack-like lines · ${number(f.skeleton_length_px)} px of centerline · ${number(f.branch_clusters)} branch clusters.`;
            case 'pothole':
                return `Possible pothole outline · ${number(f.crop_fraction * 100)}% of the detection crop. Shadows can affect the outline.`;
            case 'clogged_drainage':
                return `Textured material covers ${number(f.crop_fraction * 100)}% of the crop. The drain opening needs inspection.`;
            case 'broken_streetlight':
                return `${number(f.line_segments)} straight line segments in the crop. Fixture condition and electrical safety need inspection.`;
            default:
                return 'Visual measurement unavailable.';
        }
    }

    function render(items, escape) {
        if (!Array.isArray(items) || !items.some(Boolean)) return '';
        return `<div class="visual-extent"><strong>Visual observations (experimental)</strong>${items.map((item, index) => {
            if (!item) return '';
            const grid = item.grid ? ` · ${item.grid[0]} × ${item.grid[1]} px grid` : '';
            const stability = item.features?.threshold_stability_iou;
            const overlap = Number.isFinite(stability) ? ` · Mask overlap after a contrast-threshold change: ${number(stability * 100)}%` : '';
            return `<p>Photo ${index + 1}: ${escape(describe(item))} <small>${escape('OpenCV analysis v' + item.version + grid + overlap)}</small></p>`;
        }).join('')}<p>Pixel measurements depend on framing. Physical severity needs independent evidence.</p></div>`;
    }
    return { render };
});
