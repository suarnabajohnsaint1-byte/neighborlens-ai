(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.ReportVocabulary = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const CANONICAL_DAMAGE_CATEGORIES = Object.freeze(['broken_streetlight', 'clogged_drainage', 'pothole', 'road_crack']);
    const DISPLAY_LABELS = Object.freeze({ broken_streetlight: 'Broken Streetlight', clogged_drainage: 'Clogged Drainage', pothole: 'Pothole', road_crack: 'Road Crack' });
    const REPORT_CATEGORY_BY_CLASS = Object.freeze({ broken_streetlight: 'Street Light Damage', clogged_drainage: 'Flooding / Drainage', pothole: 'Road Damage', road_crack: 'Road Damage' });
    const AI_REPORT_CATEGORIES = Object.freeze([...new Set(Object.values(REPORT_CATEGORY_BY_CLASS))]);
    const ANALYTICS_DAMAGE_CATEGORIES = Object.freeze([
        Object.freeze({ key: 'pothole', label: DISPLAY_LABELS.pothole, classes: Object.freeze(['pothole']) }),
        Object.freeze({ key: 'road_crack', label: DISPLAY_LABELS.road_crack, classes: Object.freeze(['road_crack']) }),
        Object.freeze({ key: 'damaged_street_light', label: DISPLAY_LABELS.broken_streetlight, classes: Object.freeze(['broken_streetlight', 'damaged_street_light']) }),
        Object.freeze({ key: 'clogged_drainage', label: DISPLAY_LABELS.clogged_drainage, classes: Object.freeze(['clogged_drainage']) })
    ]);
    const statuses = Object.freeze({ pending: 'Pending', ongoing: 'Ongoing', resolved: 'Resolved', rejected: 'Rejected' });
    const priorities = Object.freeze(['Critical', 'High', 'Medium', 'Low']);
    const transitions = Object.freeze({ pending: Object.freeze(['ongoing', 'resolved', 'rejected']), ongoing: Object.freeze(['resolved', 'rejected']), resolved: Object.freeze([]), rejected: Object.freeze([]) });
    const V9_MODEL_VERSION = 'neighborlens_yolov8m_v9';
    const V9_TRAINING_RUN = 'yolov8m_v9_qa_filtered_exp01';
    const V9_MODEL_DISPLAY_NAME = 'NeighborLens-AI YOLOv8m';
    const v9ModelLabels = new Set([
        'yolov8m v9', 'neighborlens yolov8m, v9',
        `neighborlens yolov8m ${V9_MODEL_VERSION}`, `neighborlens yolov8m ${V9_TRAINING_RUN}`
    ]);
    const isCanonicalDamageCategory = value => CANONICAL_DAMAGE_CATEGORIES.includes(value);
    const isAiReportCategory = value => AI_REPORT_CATEGORIES.includes(value);
    const displayLabelFor = value => isCanonicalDamageCategory(value) ? DISPLAY_LABELS[value] : null;
    const reportCategoryFor = value => isCanonicalDamageCategory(value) ? REPORT_CATEGORY_BY_CLASS[value] : null;

    function category(value) {
        const text = String(value || '').trim();
        const group = AI_REPORT_CATEGORIES.find(item => item.toLowerCase() === text.toLowerCase());
        const normalized = text.toLowerCase().replace(/[ -]+/g, '_');
        const key = normalized === 'damaged_street_light' ? 'broken_streetlight' : normalized;
        return group || (Object.hasOwn(REPORT_CATEGORY_BY_CLASS, key) ? REPORT_CATEGORY_BY_CLASS[key] : 'Uncategorized');
    }
    function categoryOf(report) {
        if (report.citizenCategory) return category(report.citizenCategory);
        if (report.originalAi) return report.originalAi.status === 'DETECTED' ? category(report.originalAi.canonical_class) : 'Uncategorized';
        return category(report.ai_category ?? report.aiCategory);
    }
    function classification(value) {
        const normalized = String(value ?? '').trim().toUpperCase();
        return ['MAJOR', 'MINOR'].includes(normalized) ? normalized : 'UNCLASSIFIED';
    }
    function matchesCategory(report, filter) {
        if ([...AI_REPORT_CATEGORIES, 'Uncategorized'].includes(filter)) return categoryOf(report) === filter;
        return String(report.citizenCategory || report.ai_category || report.aiCategory || '').trim().toLowerCase() === String(filter).trim().toLowerCase();
    }
    function priority(value) { return priorities.find(item => item.toLowerCase() === String(value ?? '').trim().toLowerCase()) || null; }
    function confidence(value) {
        if (value === null || value === undefined || value === '') return 'Not available';
        const number = Number(String(value).replace(/%$/, ''));
        return Number.isFinite(number) && number >= 0 && number <= 100 ? `${number}%` : 'Not available';
    }
    function reviewStatuses(role, status) {
        return role === 'barangay' && Object.hasOwn(transitions, status) ? transitions[status].slice() : [];
    }
    function aiModelDisplayName(label, metadata) {
        const recorded = typeof label === 'string' ? label.trim() : '';
        if (typeof metadata?.version === 'string' && typeof metadata?.architecture === 'string') {
            return metadata.architecture.toLowerCase() === 'yolov8m'
                && [V9_MODEL_VERSION, V9_TRAINING_RUN].includes(metadata.version) ? V9_MODEL_DISPLAY_NAME : recorded || null;
        }
        return v9ModelLabels.has(recorded.toLowerCase()) ? V9_MODEL_DISPLAY_NAME : recorded || null;
    }
    function reportModelDisplayName(report) {
        if (!report.originalAi) return aiModelDisplayName(report.aiModel);
        const photos = report.originalAi.photos;
        const names = Array.isArray(photos) ? photos.map(photo => aiModelDisplayName(photo?.model)).filter(Boolean) : [];
        return [...new Set(names)].join(', ') || null;
    }
    return {
        CANONICAL_DAMAGE_CATEGORIES, DISPLAY_LABELS, REPORT_CATEGORY_BY_CLASS, AI_REPORT_CATEGORIES, ANALYTICS_DAMAGE_CATEGORIES,
        isCanonicalDamageCategory, isAiReportCategory, displayLabelFor, reportCategoryFor, statuses, priorities, transitions,
        category, categoryOf, matchesCategory, classification, priority, confidence, reviewStatuses,
        aiModelDisplayName, reportModelDisplayName
    };
});
