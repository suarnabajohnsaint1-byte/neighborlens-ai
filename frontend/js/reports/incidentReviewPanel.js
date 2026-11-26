(function (root) {
    'use strict';
    function mount(container, report, { role } = {}) {
        const document = container.ownerDocument, section = document.createElement('section');
        section.className = 'rd-section rd-incident-review';
        section.hidden = true;
        const heading = document.createElement('h2'); heading.textContent = role === 'citizen' ? 'Incident progress' : 'Incident and jurisdiction review';
        const content = document.createElement('div'), feedback = document.createElement('p'); feedback.setAttribute('role', 'status');
        section.append(heading, content, feedback); container.append(section);
        const controller = new AbortController(), base = `/api/reports/${report.id}`;
        let alive = true, busy = false, state, revision = 0;
        const node = (tag, text) => { const element = document.createElement(tag); if (text) element.textContent = text; return element; };
        function label(form, text, element) { const wrapper = node('label', text); wrapper.append(element); form.append(wrapper); return element; }
        function reason(form) { const value = node('textarea'); value.name = 'reason'; value.required = true; value.minLength = 10; value.maxLength = 500; value.rows = 2; return label(form, 'Review reason', value); }
        function evidence(form, member) {
            const select = node('select'); select.multiple = true; select.required = true; select.name = 'evidence';
            for (const image of member.images || []) { const option = node('option', `Photo ${image.imageOrder || image.image_order || image.order || image.id}`); option.value = image.id; select.append(option); }
            label(form, `Supporting location photos for report #${member.id}`, select);
            return () => [...select.selectedOptions].map(option => Number(option.value));
        }
        async function save(path, method, body, form) {
            if (busy || !alive) return; busy = true;
            const serialized = JSON.stringify(body);
            if (form.dataset.payload !== serialized) { form.dataset.payload = serialized; form.dataset.key = root.crypto.randomUUID(); }
            form.querySelectorAll('button').forEach(button => { button.disabled = true; }); feedback.textContent = 'Saving review…';
            try {
                await root.apiRequest(base + path, { method, body: { ...body, requestKey: form.dataset.key }, signal: controller.signal });
                feedback.textContent = 'Review saved.'; await load(); root.dispatchEvent(new CustomEvent('publication:changed', { detail: { reportId: report.id, reportChanged: true } }));
            } catch (error) { if (alive && error.name !== 'AbortError') feedback.textContent = error.message || 'Review could not be saved. Reload before trying again.'; }
            finally { busy = false; if (alive) form.querySelectorAll('button').forEach(button => { button.disabled = false; }); }
        }
        function action(form, title, handler) {
            const button = node('button', title); button.type = 'submit'; form.append(button);
            form.addEventListener('submit', event => { event.preventDefault(); if (form.reportValidity()) handler(); });
        }
        function render() {
            section.hidden = false;
            heading.textContent = role === 'citizen' ? 'Incident progress' : role === 'admin' && state.canAssignJurisdiction !== true ? 'Incident information' : 'Incident and jurisdiction review';
            content.replaceChildren();
            if (role === 'admin' && state.canAssignJurisdiction !== true && !state.incident) { section.hidden = true; return; }
            if (state.incident) content.append(node('p', `Linked to incident report #${state.incident.canonicalReportId}. Incident progress: ${state.incident.status}. Your original report remains ${state.originalStatus}.`));
            else if (role === 'citizen') { section.hidden = true; return; }
            if (role === 'citizen') return;
            if (role === 'barangay') {
                const duplicate = node('details'), summary = node('summary', 'Possible duplicate review'); duplicate.append(summary);
                duplicate.append(node('p', 'Suggestions require physical inspection and confirmation. Nearby damage can be a separate or recurring incident.'));
                const options = (state.candidates || []).filter(item => item.kind === 'possible_duplicate');
                if (options.length && !state.incident) {
                    const form = node('form'), targets = node('select'); targets.name = 'target'; targets.required = true;
                    for (const item of options) { const option = node('option', `Report #${item.reportId} · ${item.distanceMeters} m · ${item.status}`); option.value = item.reportId; targets.append(option); }
                    label(form, 'Possible incident report', targets);
                    const decision = node('select'); for (const [value, title] of [['dismissed', 'Distinct damage — dismiss suggestion'], ['confirmed', 'Confirmed same unresolved incident']]) { const option = node('option', title); option.value = value; decision.append(option); }
                    label(form, 'Inspection decision', decision); const note = reason(form);
                    action(form, 'Save duplicate review', async () => {
                        try {
                            const target = await root.apiRequest(`/api/reports/${targets.value}/incident-review`, { signal: controller.signal });
                            await save('/duplicate-review', 'POST', { targetReportId: Number(targets.value), decision: decision.value, reason: note.value, expectedIncidentVersion: state.incident?.version || 0, expectedTargetIncidentVersion: target.incident?.version || 0 }, form);
                        } catch (error) { if (alive) feedback.textContent = error.message; }
                    }); duplicate.append(form);
                } else duplicate.append(node('p', state.incident ? 'This report is already linked to an incident.' : 'No matching unresolved reports were found in the current review window.'));
                for (const item of state.candidates || []) if (item.kind === 'possible_recurrence') duplicate.append(node('p', `Report #${item.reportId} is already ${item.status}. Inspect this as possible recurring damage; it cannot be linked as an unresolved duplicate.`));
                content.append(duplicate);
                const flag = node('details'); flag.append(node('summary', 'Flag incorrect jurisdiction'));
                const form = node('form'), note = reason(form), selected = evidence(form, report);
                action(form, 'Request jurisdiction review', () => save('/routing-flags', 'POST', { reason: note.value, evidenceImageIds: selected(), expectedRoutingVersion: state.routingVersion }, form));
                flag.append(form); content.append(flag);
            }
            if (role === 'admin' && state.canAssignJurisdiction === true) {
                const details = node('details'); details.append(node('summary', 'Correct report jurisdiction'));
                details.append(node('p', 'Only a unique authoritative boundary match with valid original GPS and supporting report photos can authorize a correction. Original coordinates are preserved.'));
                const form = node('form'), target = node('select'); target.required = true;
                for (const item of state.barangays) { const option = node('option', item.name); option.value = item.id; option.selected = Number(item.id) === Number(report.barangay_id); target.append(option); }
                label(form, 'Responsible Barangay', target); const note = reason(form);
                const members = state.members?.length ? state.members : [{ ...report, routingVersion: state.routingVersion }];
                const selected = members.map(member => ({ member, selection: evidence(form, member) }));
                let include;
                if (state.incident) { include = node('input'); include.type = 'checkbox'; include.required = true; label(form, 'Apply this verified correction to every report in this incident', include); }
                action(form, 'Save verified jurisdiction', () => save('/jurisdiction', 'PATCH', { barangayId: Number(target.value), reason: note.value, expectedRoutingVersion: state.routingVersion, evidenceImageIds: selected.find(item => Number(item.member.id) === Number(report.id))?.selection() || [], ...(state.incident ? { applyToIncident: include.checked, expectedIncidentVersion: state.incident.version, members: selected.map(({ member, selection }) => ({ reportId: member.id, expectedRoutingVersion: member.routingVersion, evidenceImageIds: selection() })) } : {}) }, form));
                details.append(form); content.append(details);
            }
            if (state.history?.length) {
                const history = node('details'); history.append(node('summary', 'Incident and routing history'));
                const list = node('ol'); for (const item of state.history) list.append(node('li', `${item.kind.replaceAll('_', ' ')} · ${item.created_at} · ${item.reason}`));
                history.append(list); content.append(history);
            }
        }
        function clearFeedback() { section.append(feedback); feedback.textContent = ''; feedback.className = ''; }
        async function load() {
            const version = ++revision;
            try {
                const value = await root.apiRequest(base + '/incident-review', { signal: controller.signal });
                if (!alive || version !== revision) return;
                clearFeedback();
                if (JSON.stringify(value) !== JSON.stringify(state)) { state = value; render(); }
            }
            catch (error) {
                if (alive && version === revision && error.name !== 'AbortError') {
                    if (role === 'admin' && error.status === 503 && error.code === 'INCIDENT_REVIEW_NOT_READY') {
                        state = undefined;
                        content.replaceChildren();
                        clearFeedback();
                        section.hidden = true;
                        return;
                    }
                    if (role === 'admin' && !state?.incident && state?.canAssignJurisdiction !== true) {
                        section.hidden = true;
                        feedback.className = 'rd-note rd-incident-error';
                        container.append(feedback);
                    } else section.hidden = false;
                    feedback.textContent = error.message || 'Incident progress could not be loaded. Refresh to retry.';
                }
            }
        }
        load();
        return { refresh: () => busy ? Promise.resolve() : load(), destroy() { alive = false; controller.abort(); feedback.remove(); section.remove(); } };
    }
    root.IncidentReviewPanel = { mount };
})(window);
