(function (root) {
    'use strict';
    const statuses = Object.freeze({ pending: ['clock', 'Pending'], ongoing: ['refresh', 'Ongoing'], resolved: ['check-circle', 'Resolved'], rejected: ['close', 'Rejected'] });
    function status(value) { return Object.hasOwn(statuses, value) ? statuses[value] : ['info', 'Status unavailable']; }
    function type(row) {
        const damageType = row.damageType === 'damaged_street_light' ? 'broken_streetlight' : row.damageType;
        const label = root.ReportVocabulary.displayLabelFor(damageType);
        if (label && (!row.category || row.category === root.ReportVocabulary.reportCategoryFor(damageType))) {
            return { icon: root.ReportPresentation.categoryIconName(damageType), title: label };
        }
        return { icon: root.ReportPresentation.categoryIconName(row.category, 'location-pin'), title: row.category || `Report #${row.id}` };
    }
    function node(document, tag, className, text) {
        const element = document.createElement(tag); element.className = className;
        if (text !== undefined) element.textContent = text;
        return element;
    }
    function icon(document, name) { const element = node(document, 'span', `gis-icon gis-icon--${name}`); element.setAttribute('aria-hidden', 'true'); return element; }
    function statusElement(document, value) {
        const [name, label] = status(value), element = node(document, 'span', 'gis-status');
        element.dataset.status = Object.hasOwn(statuses, value) ? value : 'unknown';
        element.append(icon(document, name), node(document, 'span', '', label)); return element;
    }
    function classificationElement(document, value) {
        const classification = ['MAJOR', 'MINOR'].includes(value) ? value.toLowerCase() : 'unclassified';
        const label = classification[0].toUpperCase() + classification.slice(1);
        const element = node(document, 'span', 'gis-classification');
        element.dataset.classification = classification;
        element.append(icon(document, 'circle'), node(document, 'span', '', label));
        return element;
    }
    function legend(element) {
        element.replaceChildren(); element.classList.add('report-gis-legend'); element.setAttribute('role', 'group'); element.setAttribute('aria-label', 'Report status legend');
        for (const value of Object.keys(statuses)) element.append(statusElement(element.ownerDocument, value));
        for (const value of ['MAJOR', 'MINOR']) element.append(classificationElement(element.ownerDocument, value));
    }
    function locator(document) {
        const controls = node(document, 'div', 'gis-barangay-locator');
        controls.setAttribute('role', 'group');
        controls.setAttribute('aria-label', 'Map area');
        const label = node(document, 'label', '', 'Barangay');
        const select = node(document, 'select', '');
        select.append(node(document, 'option', '', 'Bacolod City'));
        select.options[0].value = '';
        label.append(select);
        select.disabled = true;
        const status = node(document, 'span', 'gis-area-status', 'Loading barangay outlines...');
        const cityStatus = node(document, 'span', 'gis-area-status');
        status.setAttribute('role', 'status');
        cityStatus.setAttribute('role', 'status');
        controls.append(label, status, cityStatus);
        return { controls, select, status, cityStatus };
    }
    function popup(document, row, openReport) {
        const info = type(row), element = node(document, 'article', 'gis-report-popup');
        const heading = node(document, 'div', 'gis-popup-heading');
        const titles = node(document, 'div', 'gis-popup-titles');
        titles.append(node(document, 'h3', '', info.title), node(document, 'p', '', row.category || 'Category unavailable'));
        heading.append(icon(document, info.icon), titles);
        const metadata = node(document, 'div', 'gis-popup-metadata'); metadata.append(statusElement(document, row.status));
        if (row.status !== 'resolved') metadata.append(classificationElement(document, row.classification));
        if (row.status !== 'resolved' && row.priority && row.priority !== 'Unprioritized') metadata.append(node(document, 'span', 'gis-priority', row.priority));
        element.append(heading, metadata);
        const location = node(document, 'p', 'gis-popup-line'); location.append(icon(document, 'location-pin'), node(document, 'span', '', row.location || row.barangay || 'Location unavailable')); element.append(location);
        const formatted = row.createdAt && root.ManilaDates?.format(row.createdAt);
        if (formatted) { const date = node(document, 'p', 'gis-popup-line'); date.append(icon(document, 'clock'), node(document, 'time', '', formatted)); element.append(date); }
        if (row.description) element.append(node(document, 'p', 'gis-popup-description', row.description));
        const button = node(document, 'button', 'gis-popup-action', 'View report details'); button.type = 'button';
        button.append(icon(document, 'arrow-right')); button.addEventListener('click', () => openReport(row.id, button)); element.append(button);
        return element;
    }
    function marker(row) {
        const info = type(row), [statusIcon, label] = status(row.status), major = row.classification === 'MAJOR';
        const statusKey = Object.hasOwn(statuses, row.status) ? row.status : 'unknown';
        const pinTone = ['resolved', 'rejected'].includes(statusKey) ? statusKey : major ? 'major' : row.classification === 'MINOR' ? 'minor' : statusKey;
        return { label: `${info.title}, ${label}, ${major ? 'Major' : row.classification === 'MINOR' ? 'Minor' : 'Unclassified'}, report ${row.id}`,
            html: `<span class="gis-pin" data-tone="${pinTone}"><span class="gis-pin-content"><span class="gis-icon gis-icon--${info.icon}"></span></span></span><span class="gis-marker-status" data-status="${statusKey}"><span class="gis-icon gis-icon--${statusIcon}"></span></span>` };
    }
    function cluster(rows) {
        const kinds = new Map();
        for (const row of rows) {
            const info = type(row), name = info.icon === 'location-pin' ? 'report' : info.icon;
            if (!kinds.has(name)) kinds.set(name, { title: info.title, count: 0 });
            kinds.get(name).count++;
        }
        const entries = [...kinds].sort(([a], [b]) => a.localeCompare(b));
        const symbols = entries.map(([name]) => `<span class="gis-icon gis-icon--${name}" aria-hidden="true"></span>`).join('');
        return { label: `${rows.length} reports in ${rows[0].barangay || 'this area'}: ${entries.map(([, info]) => `${info.count} ${info.title}`).join(', ')}. Select or zoom to explore`,
            html: `<span class="gis-cluster${entries.length > 1 ? ' gis-cluster--mixed' : ''}"><span class="gis-cluster-icons" aria-hidden="true">${symbols}</span><span class="gis-cluster-count">${rows.length}</span></span>` };
    }
    root.ReportGisPresentation = { statuses, status, type, node, icon, statusElement, legend, locator, popup, marker, cluster };
})(window);
