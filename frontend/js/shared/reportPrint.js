(function (root) {
    'use strict';

    function action(id) {
        if (!/^[1-9]\d*$/.test(String(id))) return '';
        return `<button type="button" class="portal-button-secondary report-print-action" data-print-report="${id}" aria-label="Print report ${id}"><i class="bx bx-printer" aria-hidden="true"></i>Print</button>`;
    }

    function reportMarkup({ report, history }, entry, apiBase) {
        const view = root.ReportPresentation;
        const vocabulary = root.ReportVocabulary;
        const { escape, date } = view;
        const facts = fields => `<dl>${fields.map(([label, value]) =>
            `<div><dt>${escape(label)}</dt><dd>${escape(value || 'Not recorded')}</dd></div>`).join('')}</dl>`;
        function photos(images, label, reportId) {
            if (!images.length) return '<p>No photos recorded.</p>';
            const figures = images.map(image => {
                const url = view.imageUrl(image.imagePath, apiBase);
                const caption = `${label} ${escape(image.imageOrder)}`;
                return `<figure><div class="rm-print-photo-frame">${url ? `<img data-evidence-deferred data-evidence-url="${escape(url)}"${reportId ? ` data-evidence-report="${escape(reportId)}" data-evidence-order="${escape(image.imageOrder)}"` : ''} alt="${caption}" referrerpolicy="no-referrer">` : '<span>Photo unavailable</span>'}</div><figcaption>${caption}</figcaption></figure>`;
            });
            const rows = [];
            for (let index = 0; index < figures.length; index += 2) {
                rows.push(`<div class="rm-print-photo-row">${figures.slice(index, index + 2).join('')}</div>`);
            }
            return rows.join('');
        }
        const address = report.location?.trim();
        const addressRecorded = address && !/^[+-]?\d+(?:\.\d+)?\s*,\s*[+-]?\d+(?:\.\d+)?$/.test(address);
        const events = view.timeline(report, history);
        const title = root.ReportCard.displayTitle(report);
        const classification = vocabulary.classification(report.ai_classification);
        const submittedBy = report.submitted_by_username || entry.submittedBy;
        return `<article class="rm-print-report" data-report-id="${escape(report.id)}">
            <h2>Report #${escape(report.id)} · ${escape(title)}</h2>
            ${facts([
                ['Status', view.statuses[report.status]], ['Assigned barangay', report.barangay],
                ['Submitted', date(report.created_at)], ['Last updated', date(report.updated_at)],
                ['Severity', { MAJOR: 'Major', MINOR: 'Minor', UNCLASSIFIED: 'Not assessed' }[classification]],
                ['Priority', vocabulary.priority(report.ai_priority) || 'Not set'],
                ...(submittedBy ? [['Submitted by', submittedBy]] : []),
                ...(entry.publication ? [['Community publication', entry.publication]] : []),
                ...(entry.requestedAt ? [['Publication requested', date(entry.requestedAt)]] : [])
            ])}
            <h3>Address</h3><p>${escape(addressRecorded ? address : 'Street address not recorded.')}</p>
            <h3>Description</h3><p>${escape(report.description || 'Description not recorded.')}</p>
            <h3>Damage category</h3><p>${escape(view.damage(report).title)}</p>
            <h3>Submitted evidence</h3>${photos(report.images || [], 'Evidence photo', report.id)}
            <h3>Report activity</h3>
            ${events.length ? `<ol class="rm-print-activity">${events.map(event => `<li><strong>${escape(event.title)}</strong> · ${escape(date(event.time))}
                ${event.actor ? ` · ${escape(event.actor)}` : ''}<p>${escape(event.description)}</p>
                ${event.proofs?.length ? photos(event.proofs, 'Proof of action') : ''}</li>`).join('')}</ol>` : '<p>No dated activity recorded.</p>'}
        </article>`;
    }

    function create(feedback, apiBase) {
        const document = feedback.ownerDocument;
        let section, controller, previousTitle, printTitle;
        function clear() {
            section?.querySelectorAll('img[data-evidence-url]').forEach(image => root.ReportEvidence.release(image));
            section?.remove();
            section = null;
            document.documentElement.style.removeProperty('--report-print-heading');
            if (printTitle && document.title === printTitle) document.title = previousTitle;
            printTitle = previousTitle = null;
            root.removeEventListener('afterprint', clear);
        }
        function cancel() {
            controller?.abort();
            clear();
            feedback.textContent = '';
        }
        root.addEventListener('session:changed', cancel);
        async function print(prepare, button) {
            if (controller || section) return;
            const active = new AbortController();
            controller = active;
            const session = root.getSession();
            button.setAttribute('aria-busy', 'true');
            button.setAttribute('aria-disabled', 'true');
            feedback.textContent = 'Preparing report details and photos…';
            try {
                const { entries, title, intro = '', summary = '' } = await prepare(active.signal);
                if (active.signal.aborted) return;
                if (!entries.length) {
                    feedback.textContent = 'No reports match these filters.';
                    return;
                }
                const articles = [];
                for (let index = 0; index < entries.length; index += 4) {
                    const batch = await Promise.all(entries.slice(index, index + 4).map(async entry => {
                        const data = await root.ReportDetailsApi.load(entry.id, { api: root.neighborLensApiUrl, session, signal: active.signal });
                        if (!data.historyAvailable) throw new Error(`Report #${entry.id} activity could not be loaded. Please retry.`);
                        return reportMarkup(data, entry, apiBase);
                    }));
                    if (active.signal.aborted) return;
                    articles.push(...batch);
                    feedback.textContent = `Preparing print · ${articles.length} of ${entries.length} reports loaded`;
                }
                section = document.createElement('section');
                section.className = 'rm-print-section';
                section.innerHTML = `<p class="rm-print-brand">NeighborLens AI</p><h1>${root.ReportPresentation.escape(title)}</h1>${intro ? `<p>${root.ReportPresentation.escape(intro)}</p>` : ''}${summary}${articles.join('')}`;
                document.body.append(section);
                await root.ReportEvidence.ready(section, active.signal);
                if (active.signal.aborted) return;
                if (session?.apiToken !== root.getSession()?.apiToken) throw new Error('The session changed. Open the report again to print it.');
                const barangay = session?.role === 'barangay' ? String(session.barangay || '').trim().replace(/\s+/g, ' ') : '';
                const heading = barangay ? (/^Barangay\b/i.test(barangay) ? barangay : `Barangay ${barangay}`) : 'NeighborLens AI';
                document.documentElement.style.setProperty('--report-print-heading', JSON.stringify(heading));
                previousTitle = document.title;
                printTitle = `${heading} - ${title}`;
                document.title = printTitle;
                root.addEventListener('afterprint', clear, { once: true });
                root.print();
                feedback.textContent = '';
            } catch (error) {
                clear();
                if (!active.signal.aborted) feedback.textContent = error.message || 'The report could not be prepared for printing. Please retry.';
            } finally {
                active.abort();
                button.removeAttribute('aria-busy');
                button.removeAttribute('aria-disabled');
                controller = null;
            }
        }
        return { print, destroy() { cancel(); root.removeEventListener('session:changed', cancel); } };
    }

    root.ReportPrint = { action, create };
})(window);
