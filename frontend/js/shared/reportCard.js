(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory(require('./reportPresentation'), require('../../../shared/reportVocabulary'));
    else root.ReportCard = factory(root.ReportPresentation, root.ReportVocabulary);
})(typeof window !== 'undefined' ? window : globalThis, function (presentation, vocabulary) {
    'use strict';
    const escape = presentation.escape;
    const normalizeDescription = value => value.trim().replace(/\s+/g, ' ').replace(/\.$/, '').toLowerCase();
    function adapt(report) {
        return { ...report, ai_category: report.ai_category ?? report.aiCategory, created_at: report.created_at ?? report.createdAt,
            ai_classification: report.ai_classification ?? report.aiClassification, ai_priority: report.ai_priority ?? report.aiPriority };
    }
    function summary(input) {
        const report = adapt(input), damage = presentation.damage(report);
        const original = damage.fields.find(([label]) => label === 'Original YOLO prediction')?.[1];
        const detected = Boolean(original);
        return { title: detected && !damage.corrected ? original : damage.title,
            detail: detected ? `AI detected: ${original}${report.originalAi.suggested_category ? ` (${report.originalAi.suggested_category})` : ''}`
                : report.originalAi ? `AI result: ${damage.fields[0]?.[1] || 'Not available'}` : damage.note,
            detected, correction: damage.corrected ? `Citizen correction: ${report.citizenCategory}` : null };
    }
    function photoUrl(report, id, order, apiBase) {
        const photos = Array.isArray(report.images) && report.images.length ? report.images : [report.image];
        const image = photos.find(image => Number(image?.imageOrder) === order) || photos[order - 1];
        const imageId = typeof image === 'object' ? image?.id : report.imageIds?.[order - 1];
        const source = typeof image === 'object' ? image?.imagePath : image;
        return presentation.imageUrl(imageId && /^[1-9]\d*$/.test(String(id)) ? `/api/reports/${id}/images/${imageId}` : source, apiBase);
    }
    function photo(report, id, order, apiBase) {
        const url = photoUrl(report, id, order, apiBase);
        return `<div class="mr-photo">${url ? `<img data-evidence-url="${escape(url)}" data-evidence-report="${escape(id)}" data-evidence-order="${order}" alt="Evidence photo ${order}" loading="lazy" referrerpolicy="no-referrer">` : `<span class="mr-photo-empty">Photo ${order} unavailable</span>`}</div>`;
    }
    function status(report, className) {
        return `<span class="${className}" data-status="${escape(report.status)}">${escape(vocabulary.statuses[report.status] || 'Unknown status')}</span>`;
    }
    function categoryIcon(input) {
        const report = adapt(input);
        const ai = report.originalAi;
        const damageType = ai?.status === 'DETECTED' ? ai.canonical_class : ai ? null : report.ai_category;
        const selected = report.citizenCategory;
        const matchesDetection = damageType && vocabulary.category(damageType) === vocabulary.category(selected);
        return presentation.categoryIcon(!selected || matchesDetection ? damageType : selected);
    }
    function gridCard(report, item, id, apiBase, detailsUrl, compact, printAction) {
        const title = displayTitle(report, item);
        const date = presentation.date(report.created_at, { dateOnly: true });
        const suggested = !report.ai_classification && ['MINOR', 'MAJOR'].includes(report.suggestedClassification);
        const classification = vocabulary.classification(report.ai_classification || report.suggestedClassification);
        const priority = vocabulary.priority(report.ai_priority);
        const link = /^report-details\.html\?id=[1-9]\d*$/.test(detailsUrl || '') ? detailsUrl : null;
        const action = detailsUrl === undefined
            ? `<button type="button" class="report-card-open" data-action="view" aria-label="View details for report ${escape(id)}">View details<i class="bx bx-right-arrow-alt" aria-hidden="true"></i></button>`
            : link
                ? `<a class="report-card-open" href="${escape(link)}" aria-label="View details for report ${escape(id)}">View details<i class="bx bx-right-arrow-alt" aria-hidden="true"></i></a>`
                : '<span class="report-card-sync">Report is being saved</span>';
        const media = `<div class="mr-photos report-card-media">${photo(report, id, 1, apiBase)}</div>`;
        return `<article class="report-card${detailsUrl !== undefined ? ' overview-report' : ''}${compact ? ' report-card--compact' : ''}" role="listitem" data-report-id="${escape(id)}">
            ${compact ? '' : media + status(report, 'report-card-status')}
            <div class="report-card-body">
                ${compact ? media : ''}
                <div class="report-card-top"><span class="report-card-id">#${escape(id)}</span>${compact ? status(report, 'report-card-status') : ''}</div>
                <h3 class="report-card-title">${categoryIcon(report)}${escape(title)}</h3>
                <div class="report-card-metadata">
                    <p class="report-card-location"><i class="bx bx-map" aria-hidden="true"></i><span>${escape(report.barangay || 'Location not recorded')}</span></p>
                    <p><i class="bx bx-calendar" aria-hidden="true"></i>${date ? `<time datetime="${escape(report.created_at)}">${escape(date)}</time>` : '<span>Date not recorded</span>'}</p>
                    ${compact?.submittedBy ? `<p>By ${escape(compact.submittedBy)}</p>` : ''}
                    ${compact?.publication ? `<p>${escape(compact.publication)}</p>` : ''}
                </div>
                <p class="report-card-description">${escape(report.description || 'No description recorded.')}</p>
                <footer class="report-card-footer"><div class="report-card-facts"><span><i class="bx bx-list-ul" aria-hidden="true"></i>${escape(classification === 'UNCLASSIFIED' ? 'Unclassified' : `${suggested ? 'AI suggested ' : ''}${classification === 'MAJOR' ? 'Major' : 'Minor'}`)}</span><span><i class="bx bx-flag" aria-hidden="true"></i>${escape(priority ? `${priority} priority` : 'Unprioritized')}</span></div>${action}${printAction}</footer>
            </div></article>`;
    }
    function render(input, { detailsUrl, apiBase, staff = false, compact, printAction = '' } = {}) {
        const report = adapt(input), item = summary(report), id = report.backendId ?? report.id;
        if (staff) return gridCard(report, item, id, apiBase, detailsUrl, compact, printAction);
        const date = presentation.date(report.created_at);
        const location = String(report.barangay ?? '').trim() || String(report.location ?? '').split(',')[0].trim() || 'Location not recorded';
        const description = String(report.description ?? '').trim();
        const repeatsDetection = description && item.detected && normalizeDescription(description) === normalizeDescription(item.detail);
        const showAssessment = item.detected ? Boolean(item.correction)
            : Boolean(report.originalAi) || report.evidenceStatus === 'EVIDENCE_REVIEW_REQUIRED';
        return `<div class="mr-row" role="listitem" data-report-id="${escape(id)}">
            <div class="mr-photos">${[1, 2].map(order => photo(report, id, order, apiBase)).join('')}</div>
            <div class="mr-body"><div class="mr-heading"><h2>${detailsUrl ? `<a class="report-entry-link" href="${escape(detailsUrl)}" aria-label="View details for report ${escape(id)}">${escape(item.title)}</a>` : escape(item.title)}</h2>
                ${item.detected ? '<span class="mr-ai" title="Original AI detection"><i class="bx bx-chip" aria-hidden="true"></i>AI</span>' : ''}
                ${item.correction ? `<span class="mr-correction" title="${escape(item.correction)}">Citizen correction</span>` : ''}</div>
                ${showAssessment ? `<p class="mr-assessment">${escape(item.detail)}</p>` : ''}${description && !repeatsDetection ? `<p class="mr-description">${escape(description)}</p>` : ''}
                <p class="mr-location"><i class="bx bx-map" aria-hidden="true"></i><span>${escape(location)}</span></p></div>
            <div class="mr-meta">${status(report, 'mr-status')}${date ? `<time datetime="${escape(report.created_at)}">${escape(date)}</time>` : '<span class="mr-date-empty">Submission date not recorded</span>'}</div>
            ${detailsUrl ? '<i class="bx bx-chevron-right mr-chevron" aria-hidden="true"></i>' : '<span class="mr-sync">Syncing</span>'}</div>`;
    }
    function displayTitle(input, item = summary(input)) {
        const report = adapt(input);
        return !report.originalAi && !report.citizenCategory ? vocabulary.displayLabelFor(report.ai_category) || item.title : item.title;
    }
    return { summary, render, adapt, photoUrl, categoryIcon, displayTitle };
});
