(function (root) {
    'use strict';
    function filterParams(query) {
        return new URLSearchParams(Object.entries(query).filter(([key, value]) => !['page', 'pageSize'].includes(key) && value != null));
    }
    function bind(button, query) {
        if (!button || button.dataset.exportBound) return;
        button.dataset.exportBound = 'true';
        const feedback = root.document.createElement('span');
        feedback.className = 'report-export-feedback';
        feedback.setAttribute('role', 'status');
        button.after(feedback);
        let busy = false;
        button.addEventListener('click', async () => {
            if (busy) return;
            busy = true; button.disabled = true; button.setAttribute('aria-busy', 'true');
            feedback.textContent = 'Preparing all matching reports...';
            try {
                const result = await root.apiRequest('/api/reports/export?' + filterParams(query()), { responseType: 'blob', cache: 'no-store' });
                if (!result.blob.type.includes('spreadsheetml.sheet')) throw new Error('The server did not return an Excel workbook.');
                const url = URL.createObjectURL(result.blob), link = root.document.createElement('a');
                link.href = url;
                link.download = /^NeighborLens_[a-zA-Z0-9_.-]+\.xlsx$/.test(result.filename || '') ? result.filename : 'NeighborLens_Reports.xlsx';
                root.document.body.append(link); link.click(); link.remove();
                setTimeout(() => URL.revokeObjectURL(url), 1000);
                feedback.textContent = 'Excel download prepared.';
            } catch (error) { feedback.textContent = error.message || 'Export failed. Please retry.'; }
            finally { busy = false; button.disabled = false; button.removeAttribute('aria-busy'); }
        });
    }
    root.ReportExport = { bind, filterParams };
})(window);
