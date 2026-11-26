(function (root) {
    'use strict';

    const classification = value => ({ MAJOR: 'Major', MINOR: 'Minor' })[value] || 'Not assessed';
    const priorities = { MAJOR: ['High', 'Critical'], MINOR: ['Low', 'Medium'] };
    const displayName = value => root.ReportVocabulary.displayLabelFor(value);
    const derivedLabels = {
        estimated_area_mm2: ['Estimated circular area', 'mm²'],
        elliptical_area_m2: ['Estimated elliptical area', 'm²'],
        total_length_m: ['Total crack length', 'm'],
        computed_obstruction_percent: ['Computed obstruction', '%']
    };
    const measurementsOf = derived => Object.entries(derived || {}).filter(([key, value]) =>
        Object.hasOwn(derivedLabels, key) && Number.isFinite(value)).map(([key, value]) => {
            const [label, unit] = derivedLabels[key];
            return `${label}: ${Number(value.toPrecision(5))} ${unit}`;
        });

    function mount(container, report, { role, draft, onSaved }) {
        const document = container.ownerDocument;
        const escape = root.ReportPresentation.escape;
        const section = document.createElement('section');
        section.className = 'rd-section rd-damage-assessment';
        const suggestion = report.severitySuggestion;
        const detected = report.originalAi?.detected ? report.originalAi.canonical_class : report.ai_category;
        const suggestedDamage = suggestion && suggestion.category !== detected ? displayName(suggestion.category) : null;
        const suggestionLabel = suggestion ? [classification(suggestion.classification), suggestedDamage].filter(Boolean).join(' · ') : 'Not assessed';
        const confirmed = report.barangayReview === 'confirmed';
        section.innerHTML = `<h2>Damage severity</h2><dl class="rd-severity-summary">
            <div><dt>Detected damage</dt><dd>${escape(displayName(detected) || 'Not confirmed')}</dd></div>
            <div><dt>AI severity suggestion</dt><dd>${escape(suggestionLabel)}</dd></div>
            <div><dt>Current classification</dt><dd data-current-classification>${classification(report.ai_classification)}</dd></div>
            <div><dt>Current priority</dt><dd data-current-priority>${escape(report.ai_priority || 'Not assessed')}</dd></div>
            <div><dt>Barangay review</dt><dd data-barangay-review>${confirmed ? 'Confirmed' : report.barangayReview === 'review_required' ? 'Further review needed' : 'Pending'}</dd></div>
            </dl>`;
        container.append(section);
        const details = document.createElement('div');
        section.append(details);
        if (role === 'citizen') {
            if (suggestion) details.textContent = `Severity basis: validated measurements · policy ${suggestion.policyVersion}`;
            return null;
        }

        const history = document.createElement('div');
        if (report.visualExtents) details.insertAdjacentHTML('beforeend', root.VisualExtentPresentation.render(report.visualExtents, escape));
        const feedback = document.createElement('p');
        feedback.setAttribute('role', 'status');
        details.append(feedback, history);
        feedback.textContent = draft?.feedback || 'Loading severity review…';
        const controller = new AbortController();
        let editor, lastStamp;

        function update(data) {
            const reviews = data.severityHistory;
            if (!Array.isArray(reviews)) return;
            const latest = reviews[0];
            const stamp = JSON.stringify([reviews, data.policyVersion, data.fields]);
            if (stamp === lastStamp) return;
            lastStamp = stamp;
            if (feedback.textContent === 'Loading severity review…') feedback.textContent = '';
            if (latest) {
                section.querySelector('[data-current-classification]').textContent = classification(latest.classification);
                section.querySelector('[data-current-priority]').textContent = latest.priority || 'Not assessed';
                section.querySelector('[data-barangay-review]').textContent = latest.classification ? 'Confirmed' : 'Further review needed';
            }
            const fields = data.fields || {};
            const evidence = (category, values, derived, uncertainty = {}) => [
                ...(fields[category] || []).filter(field => Object.hasOwn(values, field.key))
                    .map(field => `${field.label}: ${field.boolean ? (values[field.key] ? 'Yes' : 'No') : values[field.key]}${Object.hasOwn(uncertainty, field.key) ? ` ± ${uncertainty[field.key]}${field.series ? ' per segment' : ''}` : ''}`),
                ...(values.safety_impact ? [`Safety impact: ${values.safety_impact}`] : []),
                ...measurementsOf(derived)
            ].map(value => `<li>${escape(value)}</li>`).join('');
            const historyOpen = history.querySelector('details')?.open;
            history.innerHTML = `${suggestion ? `<h3>AI suggestion evidence</h3><p>Approved measurement rule · ${escape(suggestion.policyVersion)} · ${escape(suggestion.measurementSource)} (${escape(suggestion.measurementVersion)})</p><ul>${evidence(suggestion.category, suggestion.evidence || {}, suggestion.derived, suggestion.uncertainty)}</ul>` : ''}
                <p>Inspection policy: ${escape(data.policyVersion || 'Manual review')} · Last rule recommendation: ${latest?.recommendation ? classification(latest.recommendation) : 'Review required'}</p>
                <details class="rd-severity-history"${historyOpen ? ' open' : ''}><summary>Severity review history (${reviews.length})</summary>
                ${reviews.length ? `<ol>${reviews.map(item => `<li><strong>${escape(item.reviewedBy)}</strong> · <time datetime="${escape(item.createdAt)}">${escape(root.ReportPresentation.date(item.createdAt))}</time>
                    <div>${classification(item.previousClassification)} (${escape(item.previousPriority || '—')}) → ${classification(item.classification)} (${escape(item.priority || '—')})</div>
                    <p>${escape(displayName(item.category))} · ${escape(item.reason)}</p>
                    <p>Rule recommendation: ${item.recommendation ? classification(item.recommendation) : 'Review required'} · ${escape(item.policyVersion)}</p>
                    <ul>${evidence(item.category, item.evidence || {})}</ul></li>`).join('')}</ol>` : '<p>No Barangay severity reviews recorded.</p>'}</details>`;
            if (role !== 'barangay' || !Object.keys(fields).length) return;
            editor ||= createEditor(details, history, { report, detected, fields, latest, draft, feedback, controller, onSaved });
            editor.updateLatest(latest);
        }

        return { update, state: () => editor?.state(), destroy: () => controller.abort() };
    }

    function createEditor(host, history, { report, detected, fields, latest, draft, feedback, controller, onSaved }) {
        const document = host.ownerDocument;
        const form = document.createElement('form');
        const escape = root.ReportPresentation.escape;
        const option = (value, label = value) => `<option value="${escape(value)}">${escape(label)}</option>`;
        form.className = 'rd-severity-form';
        form.innerHTML = `<fieldset><legend>Barangay inspection</legend><div class="rd-severity-fields">
            <label>Damage type<select name="category" required>${option('', 'Choose damage type')}${Object.keys(fields).map(key => option(key, displayName(key))).join('')}</select></label>
            <label>Classification<select name="classification">${option('', 'Not assessed')}${option('MINOR', 'Minor')}${option('MAJOR', 'Major')}</select></label>
            <label>Priority<select name="priority"></select></label>
            <div class="rd-severity-fields rd-measurements" data-measurements></div>
            <label class="rd-severity-full">Observed safety impact<textarea name="safety_impact" maxlength="500" rows="2"></textarea></label>
            <label class="rd-severity-full">Reviewer reason<textarea name="reason" minlength="10" maxlength="500" rows="2" required></textarea></label>
            </div><div class="rd-form-actions"><button type="submit">Save assessment</button><button type="button" data-latest hidden>Use latest review as baseline</button></div></fieldset>`;
        host.insertBefore(form, history);
        const controls = form.elements;
        const fieldset = form.querySelector('fieldset');
        const save = form.querySelector('[type="submit"]');
        const baseline = form.querySelector('[data-latest]');
        const measurements = form.querySelector('[data-measurements]');
        let latestId = Number(latest?.id || 0);
        let expected = draft?.expected ?? latestId;
        let requestKey = draft?.requestKey;
        let dirty = Boolean(draft?.values);
        let saving = false;

        function renderPriority(value) {
            const choices = priorities[controls.classification.value] || [''];
            controls.priority.innerHTML = choices.map(choice => option(choice, choice || 'Not assessed')).join('');
            controls.priority.disabled = !choices[0];
            if (choices.includes(value)) controls.priority.value = value;
            controls.safety_impact.required = Boolean(controls.classification.value);
        }
        function renderMeasurements() {
            measurements.innerHTML = (fields[controls.category.value] || []).map(field => `<label>${escape(field.label)}
                ${field.boolean ? `<select name="${escape(field.key)}">${option('', 'Not measured')}${option('true', 'Yes')}${option('false', 'No')}</select>`
                    : field.series ? `<input name="${escape(field.key)}" placeholder="Comma-separated lengths">`
                        : `<input type="number" name="${escape(field.key)}" min="0" max="${escape(field.max)}" step="any" inputmode="decimal" placeholder="Not measured">`}</label>`).join('');
        }
        function reset(item) {
            controls.category.value = item?.category || (Object.hasOwn(fields, detected) ? detected : '');
            controls.classification.value = item?.classification || report.ai_classification || '';
            if (item && !item.classification) controls.classification.value = '';
            renderPriority(item?.priority || report.ai_priority);
            renderMeasurements();
            controls.reason.value = '';
            for (const [key, value] of Object.entries(item?.evidence || {})) if (controls[key]) controls[key].value = String(value);
        }
        reset(latest);
        if (draft?.values) {
            const values = draft.values;
            controls.category.value = values.category;
            controls.classification.value = values.classification;
            renderPriority(values.priority);
            renderMeasurements();
            for (const [key, value] of Object.entries(values)) if (controls[key]) controls[key].value = value;
        }
        function updateLatest(item) {
            latestId = Number(item?.id || 0);
            if (!dirty && !saving && expected !== latestId) { expected = latestId; reset(item); }
            baseline.hidden = expected === latestId;
            save.disabled = !baseline.hidden;
        }
        form.addEventListener('input', () => { dirty = true; requestKey = null; });
        controls.category.addEventListener('change', renderMeasurements);
        controls.classification.addEventListener('change', () => renderPriority(controls.priority.value));
        baseline.addEventListener('click', () => { expected = latestId; requestKey = null; updateLatest({ id: latestId }); feedback.textContent = ''; });
        form.addEventListener('submit', async event => {
            event.preventDefault();
            if (saving || expected !== latestId || !form.reportValidity()) return;
            const evidence = {};
            if (controls.safety_impact.value.trim()) evidence.safety_impact = controls.safety_impact.value.trim();
            for (const field of fields[controls.category.value] || []) {
                const value = controls[field.key].value;
                if (value === '') continue;
                if (field.boolean) evidence[field.key] = value === 'true';
                else if (field.series) evidence[field.key] = value.split(',').map(part => part.trim() ? Number(part) : null);
                else evidence[field.key] = Number(value);
            }
            const body = {
                category: controls.category.value, classification: controls.classification.value || null,
                priority: controls.priority.value || null, reason: controls.reason.value.trim(), evidence,
                expectedReviewId: expected, requestKey: requestKey ||= root.crypto.randomUUID()
            };
            saving = true; fieldset.disabled = true; feedback.textContent = 'Saving assessment…';
            try {
                const saved = await root.apiRequest(`/api/reports/${report.id}/severity`, { method: 'POST', body, signal: controller.signal });
                if (controller.signal.aborted) return;
                const item = saved.severityHistory?.[0];
                dirty = false; requestKey = null; reset(item);
                expected = Number(item?.id || expected);
                updateLatest(item);
                feedback.textContent = [`Assessment saved. ${classification(saved.severity?.classification)}.`, ...measurementsOf(saved.derived)].join(' ');
                await onSaved?.();
            } catch (error) {
                if (controller.signal.aborted) return;
                feedback.textContent = error.message;
                if (error.status === 409) await onSaved?.();
            } finally {
                saving = false;
                fieldset.disabled = false;
            }
        });
        return {
            updateLatest, state: () => ({
                expected, requestKey, feedback: feedback.textContent,
                values: dirty ? Object.fromEntries(Array.from(controls).filter(control => control.name).map(control => [control.name, control.value])) : null
            })
        };
    }

    root.ReportSeverityPanel = { mount };
})(window);
