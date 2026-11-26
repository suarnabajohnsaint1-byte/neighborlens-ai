(function (root, factory) {
    const api = factory(root);
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.ReportDetailsApi = api;
})(typeof window !== 'undefined' ? window : globalThis, function (root) {
    'use strict';

    function accessMessage(status) {
        if (status === 401) return 'Your session has expired. Sign in again to view this report.';
        if (status === 403) return 'You do not have access to this report.';
        if (status === 404) return 'Report not found. It may have been removed.';
        return null;
    }

    function failure(message, status = 0) {
        const error = new Error(message);
        error.status = status;
        error.reportDetails = true;
        return error;
    }

    function validId(id) {
        return /^[1-9]\d*$/.test(String(id ?? '')) && Number.isSafeInteger(Number(id));
    }

    async function read(id, { api, session, signal, fetchImpl = root.fetch }) {
        if (!validId(id)) throw failure('Report not found. Use a valid report link.', 404);
        if (!session?.apiToken) throw failure('Sign in with an authorized account to view this report.', 401);
        const request = path => fetchImpl(api(path), { headers: { Authorization: `Bearer ${session.apiToken}` }, cache: 'no-store', signal });
        const [response, historyResult] = await Promise.all([
            request(`/api/reports/${id}`),
            request(`/api/reports/${id}/history`).catch(() => null)
        ]);
        const denied = accessMessage(response.status) || (historyResult && accessMessage(historyResult.status));
        if (denied) throw failure(denied, response.status === 200 ? historyResult.status : response.status);
        if (!response.ok) throw failure('Report details could not be loaded. Refresh to try again.', response.status);
        const report = await response.json();
        if (String(report.id) !== String(id)) throw failure('Report details could not be verified.');
        let history = null;
        if (historyResult?.ok) {
            try { history = (await historyResult.json()).history; } catch { history = null; }
        }
        return { report, history: Array.isArray(history) ? history : null, historyAvailable: Array.isArray(history) };
    }

    async function load(id, options) {
        const controller = new AbortController();
        const abort = () => controller.abort();
        if (options.signal?.aborted) abort();
        else options.signal?.addEventListener('abort', abort, { once: true });
        const timer = setTimeout(abort, root.NEIGHBORLENS_REQUEST_TIMEOUT_MS || 20000);
        try { return await read(id, { ...options, signal: controller.signal }); }
        catch (error) {
            if (controller.signal.aborted && !options.signal?.aborted) throw failure('Report details timed out. Refresh to try again.');
            throw error;
        } finally { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); }
    }

    return { load, accessMessage, validId };
});
