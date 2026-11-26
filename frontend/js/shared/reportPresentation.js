(function (root, factory) {
    const api = factory(typeof module === 'object' && module.exports ? require('../../../shared/reportVocabulary') : root.ReportVocabulary,
        typeof module === 'object' && module.exports ? require('../../../shared/manilaDates') : root.ManilaDates);
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.ReportPresentation = api;
})(typeof self !== 'undefined' ? self : this, function (vocabulary, dates) {
    'use strict';

    const statuses = vocabulary.statuses;
    const categoryIcons = Object.freeze({
        pothole: 'pothole', road_crack: 'road-crack', broken_streetlight: 'streetlight',
        damaged_street_light: 'streetlight', clogged_drainage: 'drainage',
        'Road Damage': 'road-crack', 'Street Light Damage': 'streetlight', 'Flooding / Drainage': 'drainage'
    });
    const detections = Object.freeze({ DETECTED: 'Detected', LOW_CONFIDENCE: 'Low confidence', NO_DETECTION: 'No detection', AI_UNAVAILABLE: 'AI unavailable', PAIR_MISMATCH: 'Photos disagree', UNSUPPORTED: 'Unsupported result' });

    function escape(value) {
        return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
    }

    function categoryIconName(value, fallback = 'report') {
        return Object.hasOwn(categoryIcons, value) ? categoryIcons[value] : fallback;
    }

    function categoryIcon(value) {
        return `<span class="report-category-icon report-category-icon--${categoryIconName(value)}" aria-hidden="true"></span>`;
    }

    function number(value) {
        if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }

    function coordinates(report) {
        const lat = number(report.latitude);
        const lng = number(report.longitude);
        return lat !== null && lng !== null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
    }

    function date(value, options) {
        return dates.format(value, options);
    }

    function damage(report) {
        const ai = report.originalAi;
        const reviewRequired = [report.evidenceStatus, ai?.status].includes('EVIDENCE_REVIEW_REQUIRED');
        const selected = report.citizenCategory || null;
        const accepted = !reviewRequired && Boolean(ai?.detected && ai.status === 'DETECTED' && ai.canonical_class);
        const canonical = accepted ? ai.canonical_class : ai?.status === 'LOW_CONFIDENCE' ? ai.candidate?.canonical_class : null;
        const named = ai?.photos?.find(photo => photo.candidate?.canonical_class === canonical)?.candidate?.display_name;
        const name = named || (canonical ? canonical.replace(/_/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase()) : null);
        const corrected = Boolean(selected && ai?.suggested_category && selected !== ai.suggested_category);
        const title = selected || (accepted ? ai.suggested_category : null) || (!ai ? report.ai_category : null) || 'Category not recorded';
        let note = 'No original AI assessment was recorded.';
        if (ai) {
            note = corrected ? 'Citizen correction; the original AI suggestion is preserved below.'
                : accepted && selected ? `AI detected ${name}. Suggestion accepted.`
                : accepted ? `AI detected ${name}. No citizen category was selected.`
                : selected ? 'Citizen-selected category; no AI detection was confirmed.' : 'No citizen category was selected.';
        }
        const fields = reviewRequired ? [['Evidence', 'Manual Barangay review required']]
            : ai ? [['Detection result', detections[ai.status] || 'Not available']]
            : [['Classification', vocabulary.classification(report.ai_classification) === 'UNCLASSIFIED' ? 'Unclassified' : vocabulary.classification(report.ai_classification)],
                ['Confidence', vocabulary.confidence(report.ai_confidence)]];
        if (canonical) fields.push([accepted ? 'Original YOLO prediction' : 'Provisional candidate', name]);
        const confidence = number(ai?.confidence);
        if (canonical && confidence !== null && confidence >= 0 && confidence <= 1) fields.push(['Original AI confidence', `${Math.round(confidence * 10000) / 100}%`]);
        if (corrected || (!accepted && ai?.suggested_category)) fields.push(['AI-suggested category', ai.suggested_category]);
        if (reviewRequired) note = 'Check that both photos show the issue from different views.';
        const model = vocabulary.reportModelDisplayName(report);
        if (model && !reviewRequired) fields.push(['AI model', model]);
        return { title, note, fields, corrected, model: reviewRequired ? null : model };
    }

    function imageUrl(value, base) {
        try {
            if (typeof value !== 'string' || !value.trim()) return null;
            const url = new URL(value, base);
            return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
        } catch { return null; }
    }

    function evidence(report, base) {
        return [1, 2].map(order => {
            const image = (Array.isArray(report.images) ? report.images : []).find(item => Number(item.imageOrder) === order);
            return { order, url: imageUrl(image?.imagePath, base) };
        });
    }

    function timeline(report, rows) {
        const events = [];
        if (date(report.created_at)) events.push({ title: 'Report submitted', time: report.created_at, description: 'Evidence and report information received.' });
        for (const row of Array.isArray(rows) ? rows : []) {
            if (!statuses[row.new_status] || !date(row.created_at)) continue;
            events.push({ title: statuses[row.new_status], time: row.created_at,
                  actor: row.changed_by_username || null,
                proofs: row.proofs || [],
                description: [row.old_status && statuses[row.old_status] ? `${statuses[row.old_status]} to ${statuses[row.new_status]}` : 'Recorded status update', row.note].filter(Boolean).join('. ') });
        }
        return events;
    }

    return { escape, categoryIconName, categoryIcon, number, coordinates, date, timestamp: dates.timestamp, damage, imageUrl, evidence, timeline, statuses };
});
