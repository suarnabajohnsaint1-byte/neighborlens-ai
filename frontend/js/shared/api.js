(function () {
    'use strict';

    const hostname = window.location.hostname || '127.0.0.1';
    const API_BASE_URL = window.location.protocol === 'https:'
        ? window.location.origin
        : `http://${hostname}:3000`;
    const REQUEST_TIMEOUT_MS = 20000;
    window.NEIGHBORLENS_REQUEST_TIMEOUT_MS = REQUEST_TIMEOUT_MS;

    window.NEIGHBORLENS_API_BASE_URL = API_BASE_URL;

    window.neighborLensApiUrl = function (path) {
        const normalizedPath = String(path || '').startsWith('/')
            ? path
            : `/${path}`;

        return `${window.NEIGHBORLENS_API_BASE_URL}${normalizedPath}`;
    };

    function currentToken() {
        const session = typeof window.getSession === 'function' ? window.getSession() : null;
        return session?.apiToken || '';
    }

    function failure(message, status, code) {
        const error = new Error(message);
        error.status = status;
        if (code) error.code = code;
        return error;
    }

    window.apiRequest = async function (path, { method = 'GET', body, auth = true, signal, cache, keepalive, responseType = 'json' } = {}) {
        const token = auth ? currentToken() : '';
        if (auth && !token) {
            if (typeof window.redirectToLogin === 'function') window.redirectToLogin();
            throw failure('Please sign in to continue.', 401);
        }

        const controller = new AbortController();
        const abort = () => controller.abort();
        if (signal?.aborted) abort();
        else signal?.addEventListener('abort', abort, { once: true });
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        let response;
        let data;
        const multipart = typeof FormData !== 'undefined' && body instanceof FormData;
        try {
            response = await fetch(window.neighborLensApiUrl(path), {
                method,
                ...(keepalive ? { keepalive } : {}),
                signal: controller.signal,
                ...(cache ? { cache } : {}),
                headers: {
                    ...(body !== undefined && !multipart ? { 'Content-Type': 'application/json' } : {}),
                    ...(token ? { Authorization: `Bearer ${token}` } : {})
                },
                ...(body !== undefined ? { body: multipart ? body : JSON.stringify(body) } : {})
            });
            if (response.ok && responseType === 'blob') {
                return { blob: await response.blob(), filename: response.headers.get('Content-Disposition')?.match(/filename="([^"]+)"/)?.[1] };
            }
            data = await response.json().catch(error => {
                if (controller.signal.aborted) throw error;
                return {};
            });
        } catch (error) {
            if (signal?.aborted) throw error;
            throw failure(
                error.name === 'AbortError'
                    ? 'The server took too long to respond. Please retry.'
                    : 'Cannot reach the server. Check your connection and retry.',
                0
            );
        } finally {
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
        }

        if (response.ok) return data;

        if (response.status === 401 && auth) {
            if (currentToken() === token && typeof window.handleSessionExpired === 'function') window.handleSessionExpired();
            throw failure(data.error || 'Your session has ended. Please sign in again.', 401);
        }
        const fallback = {
            403: 'You do not have permission to perform this action.',
            404: 'The requested record was not found.',
            409: 'This change conflicts with the current data. Reload and try again.',
            429: 'Too many requests. Please wait a moment and retry.'
        }[response.status] || (response.status >= 500 ? 'The server could not complete the request. Please retry.' : 'Check the entered information.');
        throw failure(String(data.error || data.message || fallback).slice(0, 240), response.status, data.code);
    };
})();
