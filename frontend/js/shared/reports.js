const REPORTS_KEY = 'up_reports';
const REPORTS_CONTEXT_KEY = 'up_reports_context';
let reportCacheEpoch = 0;
let activeReportContext = null;
let activeReportDetailId = null;
let reportSyncGeneration = 0;
let reportSyncActive = 0;
let reportPollingStarted = false;
let reportRefreshPromise = null;
let reportRefreshQueued = false;
const pendingReportIds = new Set();
const reportMemory = new Map();
let reportLoadState = { status: 'idle', message: '', hasData: false };

function reportStorageGet(key) {
    try {
        const value = sessionStorage.getItem(key);
        if (value === null) reportMemory.delete(key); else reportMemory.set(key, value);
        return value;
    } catch { return reportMemory.get(key) ?? null; }
}
function reportStorageSet(key, value) {
    reportMemory.set(key, value);
    try { sessionStorage.setItem(key, value); } catch { }
}
function reportStorageRemove(key) {
    reportMemory.delete(key);
    try { sessionStorage.removeItem(key); } catch { }
}

for (const key of [REPORTS_KEY, REPORTS_CONTEXT_KEY]) {
    try { localStorage.removeItem(key); } catch { }
}
function getReportLoadState() { ensureReportContext(); return { ...reportLoadState }; }

function reportSession() {
    return typeof getSession === 'function' ? getSession() : null;
}

function reportContext(session) {
    if (!session?.apiToken || session.id == null || !['admin', 'barangay', 'citizen'].includes(session.role)) return null;
    return JSON.stringify([String(session.id), session.username || '', session.role, session.barangay || '', getApiBase()]);
}

function reportIsAccessible(report, session) {
    if (!report || !session) return false;
    if (session.role === 'citizen') {
        return (session.id != null && report.submittedById != null && String(report.submittedById) === String(session.id)) ||
            Boolean(session.username && report.submittedBy === session.username);
    }
    if (report.submittedByRole !== 'citizen') return false;
    if (session.role === 'admin') return true;
    if (session.role === 'barangay') return Boolean(session.barangay) && report.barangay === session.barangay;
    return false;
}

function clearReportDetails() {
    activeReportDetailId = null;
    if (typeof document === 'undefined') return;
    for (const id of ['reportModal', 'dataModal']) {
        const modal = document.getElementById(id);
        if (modal?.open && typeof modal.close === 'function') modal.close();
        else if (modal && modal.tagName !== 'DIALOG') modal.style.display = 'none';
    }
    for (const id of ['modalBody', 'modalTitle']) {
        const element = document.getElementById(id);
        if (element) { element.innerHTML = ''; element.textContent = ''; }
    }
}

function notifyReportsChanged() {
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') window.dispatchEvent(new CustomEvent('reports_updated'));
}

function clearReportCache(notify = true) {
    reportCacheEpoch += 1;
    activeReportContext = null;
    pendingReportIds.clear();
    reportStorageRemove(REPORTS_KEY);
    reportStorageRemove(REPORTS_CONTEXT_KEY);
    reportLoadState = { status: 'idle', message: '', hasData: false };
    clearReportDetails();
    if (notify) notifyReportsChanged();
}

function ensureReportContext(session = reportSession()) {
    const context = reportContext(session);
    const stored = reportStorageGet(REPORTS_CONTEXT_KEY);
    if (!context || stored !== context || (activeReportContext !== null && activeReportContext !== context)) {
        const hadData = Boolean(stored || reportStorageGet(REPORTS_KEY));
        clearReportCache(false);
        if (context) reportStorageSet(REPORTS_CONTEXT_KEY, context);
        activeReportContext = context;
        if (hadData) notifyReportsChanged();
    } else activeReportContext = context;
    return context;
}

function currentReportRequest(context, epoch, token) {
    const session = reportSession();
    return ensureReportContext(session) === context && reportCacheEpoch === epoch && session?.apiToken === token;
}

function getAuthorizedReport(id, role) {
    if (reportSession()?.role !== role) { clearReportDetails(); return null; }
    const report = getAllReports().find(row => row.id === id || String(row.backendId) === String(id));
    if (!report) { clearReportDetails(); return null; }
    activeReportDetailId = report.id;
    return report;
}

function getApiBase() {
    if (typeof window.neighborLensApiUrl === 'function') {
        return window.neighborLensApiUrl('').replace(/\/$/, '');
    }
    if (window.NEIGHBORLENS_API_BASE_URL) {
        return window.NEIGHBORLENS_API_BASE_URL;
    }
    const hostname = window.location.hostname || '127.0.0.1';
    return `http://${hostname}:3000`;
}

function finiteOrNull(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
}

function extractImageUrl(img) {
    if (!img) return '';
    const raw = typeof img === 'string' ? img : (img.url || img.imagePath || img.image_path || '');
    if (!raw) return '';
    const str = String(raw).trim();
    if (str.startsWith('http://') || str.startsWith('https://') || str.startsWith('data:') || str.startsWith('blob:')) {
        return str;
    }
    return str.startsWith('/') ? str : `/${str}`;
}

function parseImageUrls(raw) {
    if (!raw) return [];
    if (Array.isArray(raw)) {
        return raw.map(extractImageUrl).filter(Boolean);
    }
    if (typeof raw === 'string') {
        return raw.split(',').map(s => extractImageUrl(s.trim())).filter(Boolean);
    }
    return [];
}

function getAllReports() {
    try {
        const session = reportSession();
        if (!ensureReportContext(session)) return [];
        const reports = JSON.parse(reportStorageGet(REPORTS_KEY) || '[]');
        const accessible = Array.isArray(reports) ? reports.filter(report => reportIsAccessible(report, session)) : [];
        if (!Array.isArray(reports) || accessible.length !== reports.length) reportStorageSet(REPORTS_KEY, JSON.stringify(accessible));
        if (activeReportDetailId && !accessible.some(row => row.id === activeReportDetailId)) clearReportDetails();
        return accessible;
    }
    catch { clearReportCache(false); return []; }
}

function saveReports(reports) {
    const session = reportSession();
    if (!ensureReportContext(session)) return;
    const accessible = reports.filter(report => reportIsAccessible(report, session));
    reportStorageSet(REPORTS_KEY, JSON.stringify(accessible));
    if (activeReportDetailId && !accessible.some(row => row.id === activeReportDetailId)) clearReportDetails();
    notifyReportsChanged();
}

function addReport(report) {
    const session = typeof getSession === 'function' ? getSession() : null;
    if (session?.role !== 'citizen') return null;

    const reports = getAllReports();
    const { assessmentProofs, ...persistedReport } = report;
    const newReport = {
        id: 'RPT_' + Date.now(),
        ...persistedReport,
        submittedById: session.id,
        submittedBy: session.username || report.submittedBy,
        submittedByRole: 'citizen',
        status: 'pending',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };
    reports.unshift(newReport);
    pendingReportIds.add(newReport.id);
    saveReports(reports);

    if (session?.apiToken) {
        newReport.syncPromise = syncReportToBackend({ ...newReport, assessmentProofs }, session.apiToken).catch(err => {
            console.warn('[reports] Backend sync skipped or deferred:', err.message);
            return { ok: false, error: err.message };
        });
    }

    return newReport;
}

async function syncReportToBackend(report, token) {
    const context = ensureReportContext();
    const epoch = reportCacheEpoch;
    try {
        const formData = new FormData();
        if (report.requestKey) formData.append('requestKey', report.requestKey);
        formData.append('description', report.description || '');
        if (report.citizenCategory) {
            formData.append('citizenCategory', report.citizenCategory);
        }
        if (report.assessmentProofs) {
            formData.append('assessmentProofs', JSON.stringify(report.assessmentProofs));
        }
        formData.append('location', report.location || '');
        formData.append('barangay', report.barangay || '');
        if (Number.isFinite(report.lat)) formData.append('latitude', String(report.lat));
        if (Number.isFinite(report.lng)) formData.append('longitude', String(report.lng));
        if (Number.isFinite(report.accuracy)) formData.append('gpsAccuracy', String(report.accuracy));
        if (Number.isSafeInteger(report.gpsFixAt)) formData.append('gpsFixAt', String(report.gpsFixAt));
        formData.append('aiCategory', report.aiCategory || 'Infrastructure');
        formData.append('aiClassification', report.aiClassification || 'MINOR');
        formData.append('aiPriority', report.aiPriority || 'Low');
        const confidence = Number.parseFloat(report.aiConfidence);
        if (Number.isFinite(confidence) && confidence >= 0 && confidence <= 100) formData.append('aiConfidence', String(confidence));
        formData.append('visionDetected', report.visionDetected ? 'true' : 'false');
        if (report.rawVerification) {
            formData.append('verification', JSON.stringify(report.rawVerification));
        }

        const fileList = Array.isArray(report.files) ? report.files : (Array.isArray(report.rawFiles) ? report.rawFiles : []);
        fileList.forEach((file, index) => {
            formData.append('images', file, file.name || `evidence-photo-${index + 1}.jpg`);
        });
        if (report.landmarkFile instanceof File) {
            formData.append('landmarkImage', report.landmarkFile, report.landmarkFile.name || 'landmark.jpg');
        }
        if (report.landmarkDescription != null) {
            formData.append('landmarkDescription', String(report.landmarkDescription));
        }

        const res = await fetch(`${getApiBase()}/api/reports`, {
            cache: 'no-store',
            method: 'POST',
            headers: { Authorization: `Bearer ${token}` },
            body: formData
        });

        if (res.ok) {
            const data = await res.json();
            if (!currentReportRequest(context, epoch, token)) return { ok: false, error: 'Report session changed.' };
            const finalId = data?.reportId || data?.id;
            if (finalId) {
                const reports = getAllReports();
                const idx = reports.findIndex(r => r.id === report.id);
                if (idx !== -1) {
                    reports[idx].backendId = finalId;
                    reports[idx].citizenCategory = data.citizenCategory ?? null;
                    reports[idx].originalAi = data.originalAi ?? null;
                    const parsedList = Array.isArray(data.images) && data.images.length
                        ? parseImageUrls(data.images)
                        : parseImageUrls(data.image_path || data.imagePath);
                    if (parsedList.length) {
                        reports[idx].images = parsedList;
                        reports[idx].image = parsedList[0];
                    }
                    saveReports(reports);
                }
            }
            return { ok: true, data };
        } else {
            const errData = await res.json().catch(() => ({}));
            if (!currentReportRequest(context, epoch, token)) return { ok: false, error: 'Report session changed.' };
            const errMsg = errData.error || errData.message || res.statusText || 'Report submission rejected';
            console.warn('[reports] Server report creation rejected:', errMsg);
            const reports = getAllReports();
            const idx = reports.findIndex(r => r.id === report.id);
            if (idx !== -1) {
                reports.splice(idx, 1);
                saveReports(reports);
            }
            return { ok: false, error: errMsg, retryable: res.status >= 500 };
        }
    } catch (err) {
        console.warn('[reports] Background report creation sync error:', err.message);
        if (currentReportRequest(context, epoch, token)) saveReports(getAllReports().filter(row => row.id !== report.id));
        return { ok: false, error: err.message, retryable: true };
    } finally {
        if (currentReportRequest(context, epoch, token)) pendingReportIds.delete(report.id);
    }
}

function updateReport(id, updates) {
    const reports = getAllReports();
    const idx = reports.findIndex(r => r.id === id || String(r.backendId) === String(id));
    if (idx === -1) return null;
    reports[idx] = { ...reports[idx], ...updates, updatedAt: new Date().toISOString() };
    saveReports(reports);
    return reports[idx];
}

async function updateReportStatus(id, status, note = null) {
    const report = getAllReports().find(r => r.id === id || String(r.backendId) === String(id));
    if (!report) throw new Error('This report is no longer available to your account.');
    const backendId = report.backendId ?? (/^[1-9]\d*$/.test(String(id)) ? id : null);
    if (!backendId) throw new Error('This report is still being saved. Try again in a moment.');
    if (typeof window.apiRequest !== 'function') throw new Error('The reports service is unavailable.');

    const result = await window.ReportMutations.update(backendId, status, note);
    return updateReport(report.id, { status: result.status || status });
}

async function syncReportsFromBackend() {
    const session = reportSession();
    const context = ensureReportContext(session);
    if (!context) return;
    if (window.ReportMutations?.pending()) return;
    const epoch = reportCacheEpoch;
    const token = session.apiToken;
    const generation = ++reportSyncGeneration;
    const mutationRevision = window.ReportMutations?.revision();
    const isCurrent = () => generation === reportSyncGeneration && mutationRevision === window.ReportMutations?.revision() && currentReportRequest(context, epoch, token);
    const notifyLoadChange = getAllReports().length === 0 || reportLoadState.status === 'error';
    if (reportLoadState.status === 'idle') { reportLoadState = { status: 'loading', message: '' }; if (notifyLoadChange) notifyReportsChanged(); }

    reportSyncActive += 1;
    try {
        const controller = new AbortController();
        const deadline = setTimeout(() => controller.abort(), window.NEIGHBORLENS_REQUEST_TIMEOUT_MS || 20000);
        let res, data;
        try {
            res = await fetch(`${getApiBase()}/api/reports`, { signal: controller.signal, cache: 'no-store', headers: { Authorization: `Bearer ${token}` } });
            try { data = await res.json(); }
            catch {
                if (controller.signal.aborted) throw new DOMException('Request cancelled', 'AbortError');
                if (res.ok) throw new Error('Invalid report response.');
                data = {};
            }
        } finally { clearTimeout(deadline); }
        if (!isCurrent()) return;
        if (res.status === 401 && typeof window.handleSessionExpired === 'function') window.handleSessionExpired();
        if (!res.ok) {
            const error = new Error(res.status === 401 ? 'Your session expired or is invalid. Sign in again to load your reports.' : res.status === 403 ? 'This account is not authorized to access these reports.' : 'Reports could not be loaded from the server. Retry when connected.');
            error.status = res.status;
            throw error;
        }
        if (!isCurrent()) return;
        if (!Array.isArray(data?.reports)) throw new Error('Invalid report response.');
        const serverRows = data.reports;

        const cachedReports = getAllReports();
        const serverIds = new Set(serverRows.map(row => String(row.id)));
        const localReports = cachedReports.filter(row => serverIds.has(String(row.backendId)) || pendingReportIds.has(row.id));
        const localMap = new Map();
        localReports.forEach(r => {
            if (r.backendId) localMap.set(String(r.backendId), r);
            localMap.set(String(r.id), r);
        });

        let changed = localReports.length !== cachedReports.length;
        serverRows.forEach(sr => {
            const key = String(sr.id);
            const existing = localMap.get(key);

            const serverImgList = Array.isArray(sr.images) && sr.images.length
                ? parseImageUrls(sr.images)
                : parseImageUrls(sr.image_path || sr.imagePath);
            const ids = Array.isArray(sr.images) ? sr.images.map(image => typeof image === 'object' ? image?.id ?? null : null) : [];
            const serverImageIds = ids.some(Boolean) ? ids : [];

            if (existing) {
                if (!existing.backendId && sr.id) {
                    existing.backendId = sr.id;
                    changed = true;
                }
                const fields = {
                    description: 'description', location: 'location', barangay: 'barangay',
                    submittedBy: 'submitted_by_username', submittedById: 'submitted_by',
                    createdAt: 'created_at', updatedAt: 'updated_at'
                };
                for (const [field, serverField] of Object.entries(fields)) {
                    if (sr[serverField] !== undefined && existing[field] !== sr[serverField]) {
                        existing[field] = sr[serverField];
                        changed = true;
                    }
                }
                for (const [field, serverField] of [['lat', 'latitude'], ['lng', 'longitude'], ['accuracy', 'gps_accuracy']]) {
                    if (sr[serverField] !== undefined && existing[field] !== finiteOrNull(sr[serverField])) {
                        existing[field] = finiteOrNull(sr[serverField]);
                        changed = true;
                    }
                }
                if (existing.status !== sr.status) {
                    existing.status = sr.status;
                    changed = true;
                }
                if ('images' in sr || 'image_path' in sr || 'imagePath' in sr) {
                    const existingList = Array.isArray(existing.images) ? existing.images : [];
                    if (JSON.stringify(existingList) !== JSON.stringify(serverImgList)) {
                        existing.images = serverImgList;
                        existing.image = serverImgList[0] || '';
                        changed = true;
                    }
                    if (JSON.stringify(existing.imageIds || []) !== JSON.stringify(serverImageIds)) { existing.imageIds = serverImageIds; changed = true; }
                }
                if ('ai_confidence' in sr) {
                    const confidence = window.ReportVocabulary.confidence(sr.ai_confidence);
                    if (existing.aiConfidence !== confidence) { existing.aiConfidence = confidence; changed = true; }
                }
                const hasServerClassification = ('ai_classification' in sr && sr.ai_classification !== undefined) ||
                    ('aiClassification' in sr && sr.aiClassification !== undefined);
                if (hasServerClassification) {
                    const serverClassification = sr.ai_classification !== undefined
                        ? sr.ai_classification
                        : sr.aiClassification;
                    if (existing.aiClassification !== serverClassification) {
                        existing.aiClassification = serverClassification;
                        changed = true;
                    }
                }
                if (('ai_category' in sr && sr.ai_category !== undefined) || ('aiCategory' in sr && sr.aiCategory !== undefined)) {
                    const serverCat = sr.ai_category !== undefined ? sr.ai_category : sr.aiCategory;
                    if (existing.aiCategory !== serverCat) {
                        existing.aiCategory = serverCat;
                        changed = true;
                    }
                }
                if (('ai_priority' in sr && sr.ai_priority !== undefined) || ('aiPriority' in sr && sr.aiPriority !== undefined)) {
                    const serverPri = sr.ai_priority !== undefined ? sr.ai_priority : sr.aiPriority;
                    if (existing.aiPriority !== serverPri) {
                        existing.aiPriority = serverPri;
                        changed = true;
                    }
                }
                if (('vision_detected' in sr && sr.vision_detected !== undefined) || ('visionDetected' in sr && sr.visionDetected !== undefined)) {
                    const serverVision = Boolean(sr.vision_detected !== undefined ? sr.vision_detected : sr.visionDetected);
                    if (Boolean(existing.visionDetected) !== serverVision) {
                        existing.visionDetected = serverVision;
                        changed = true;
                    }
                }
                ['citizenCategory', 'originalAi', 'severitySuggestion', 'suggestedClassification'].forEach(field => {
                    if (field in sr && JSON.stringify(existing[field]) !== JSON.stringify(sr[field])) {
                        existing[field] = sr[field];
                        changed = true;
                    }
                });
            } else {
                const mappedClassification = ('ai_classification' in sr && sr.ai_classification !== undefined)
                    ? sr.ai_classification
                    : (sr.aiClassification !== undefined ? sr.aiClassification : null);
                const mapped = {
                    id: 'RPT_SRV_' + sr.id,
                    backendId: sr.id,
                    description: sr.description,
                    location: sr.location,
                    barangay: sr.barangay,
                    lat: finiteOrNull(sr.latitude),
                    lng: finiteOrNull(sr.longitude),
                    accuracy: finiteOrNull(sr.gps_accuracy),
                    image: serverImgList[0] || '',
                    images: serverImgList,
                    imageIds: serverImageIds,
                    aiCategory: sr.ai_category,
                    citizenCategory: sr.citizenCategory ?? null,
                    originalAi: sr.originalAi ?? null,
                    severitySuggestion: sr.severitySuggestion ?? null,
                    suggestedClassification: sr.suggestedClassification ?? null,
                    aiClassification: mappedClassification,
                    aiPriority: sr.ai_priority,
                    aiConfidence: window.ReportVocabulary.confidence(sr.ai_confidence),
                    visionDetected: Boolean(sr.vision_detected),
                    status: sr.status || 'unknown',
                    submittedBy: sr.submitted_by_username || 'citizen',
                    submittedById: sr.submitted_by,
                    submittedByRole: 'citizen',
                    createdAt: sr.created_at || new Date().toISOString(),
                    updatedAt: sr.updated_at || new Date().toISOString()
                };
                localReports.unshift(mapped);
                localMap.set(key, mapped);
                changed = true;
            }
        });

        reportLoadState = { status: 'ready', message: '', hasData: true };
        if (changed) {
            saveReports(localReports);
        } else if (notifyLoadChange) notifyReportsChanged();
    } catch (err) {
        console.warn('[reports] Background fetch error:', err.message);
        if (isCurrent()) {
            reportLoadState = {
                status: 'error', hasData: reportLoadState.hasData || getAllReports().length > 0,
                message: err.name === 'AbortError' ? 'The reports server took too long. Retry to refresh.' : err instanceof TypeError ? 'Cannot reach the reports server. Check your connection and retry.' : err.message
            };
            const keep = err instanceof TypeError || err.name === 'AbortError' || err.status >= 500 || err.status === 429;
            if (keep) notifyReportsChanged();
            else saveReports(getAllReports().filter(row => pendingReportIds.has(row.id)));
        }
    } finally { reportSyncActive -= 1; }
}

function refreshReports(queueAfterCurrent = false) {
    if (reportRefreshPromise) {
        reportRefreshQueued ||= queueAfterCurrent;
        return reportRefreshPromise;
    }
    reportRefreshPromise = (async () => {
        do {
            reportRefreshQueued = false;
            await syncReportsFromBackend();
        } while (reportRefreshQueued);
    })().finally(() => { reportRefreshPromise = null; });
    return reportRefreshPromise;
}

if (typeof window !== 'undefined') {
    window.getReportLoadState = getReportLoadState;
    window.refreshReports = refreshReports;
    window.clearReportCache = clearReportCache;
    window.addEventListener('storage', event => {
        if (event.storageArea) {
            try { if (event.storageArea !== sessionStorage) return; } catch { return; }
        }
        if ([REPORTS_KEY, REPORTS_CONTEXT_KEY].includes(event.key) || event.key === null) {
            getAllReports();
            clearReportDetails();
            notifyReportsChanged();
        }
    });
    window.addEventListener('DOMContentLoaded', () => {
        if (reportPollingStarted || window.NEIGHBORLENS_ACCESS_GRANTED === false) return;
        reportPollingStarted = true;
        refreshReports();
        setInterval(() => { if (!reportSyncActive) refreshReports(); }, 10000);
    });
}

function getReportsByBarangay(barangay) {
    return getAllReports().filter(r => r.barangay === barangay);
}

function reportMatchesSearch(report, search) {
    const query = String(search || '').trim().toLowerCase();
    return !query || [report.id, report.backendId, report.barangay, report.description, report.location,
    report.submittedBy, report.citizenCategory, report.aiCategory]
        .some(value => String(value ?? '').toLowerCase().includes(query));
}

function filterReports(reports, filters = {}) {
    let result = [...reports];

    if (filters.barangay && filters.barangay !== 'all') {
        result = result.filter(r => r.barangay === filters.barangay);
    }
    if (filters.status && filters.status !== 'all') {
        result = result.filter(r => r.status === filters.status);
    }
    if (filters.classification && filters.classification !== 'all') {
        const target = normalizeClassification(filters.classification);
        result = result.filter(r => normalizeClassification(r.aiClassification || r.suggestedClassification) === target);
    }
    if (filters.priority && filters.priority !== 'all') {
        result = result.filter(r => r.aiPriority === filters.priority);
    }
    if (filters.category && filters.category !== 'all') {
        result = result.filter(r => window.ReportVocabulary.matchesCategory(r, filters.category));
    }
    if (filters.dateFrom) {
        const from = window.ManilaDates.dayStart(filters.dateFrom);
        result = result.filter(r => window.ManilaDates.timestamp(r.createdAt) >= from);
    }
    if (filters.dateTo) {
        const to = window.ManilaDates.dayStart(filters.dateTo) + window.ManilaDates.DAY_MS;
        result = result.filter(r => window.ManilaDates.timestamp(r.createdAt) < to);
    }
    if (filters.search) {
        result = result.filter(r => reportMatchesSearch(r, filters.search));
    }

    if (filters.sort === 'oldest') {
        result.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    } else if (filters.sort === 'priority') {
        const order = { Critical: 0, High: 1, Medium: 2, Low: 3 };
        result.sort((a, b) => (order[a.aiPriority] ?? 9) - (order[b.aiPriority] ?? 9));
    } else {
        result.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    }

    return result;
}

if (typeof window !== 'undefined') {
    window.filterReports = filterReports;
    window.reportMatchesSearch = reportMatchesSearch;
}

const _refreshCallbacks = [];
function onReportsChanged(fn) { _refreshCallbacks.push(fn); }
function _notifyAll() { _refreshCallbacks.forEach(fn => { try { fn(); } catch (e) { console.error(e); } }); }
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('reports_updated', _notifyAll);
}

function simulateAI(description) {
    const majorKeywords = ['pothole', 'collapse', 'flood', 'broken', 'crack', 'damage', 'destroyed', 'fire', 'hazard', 'leak', 'sewage'];
    const lowerDesc = description.toLowerCase();
    const isMajor = majorKeywords.some(kw => lowerDesc.includes(kw));
    const priorities = ['Critical', 'High', 'Medium', 'Low'];
    return {
        classification: isMajor ? 'MAJOR' : 'MINOR',
        priority: isMajor ? priorities[Math.floor(Math.random() * 2)] : priorities[2 + Math.floor(Math.random() * 2)],
        confidence: Math.floor(75 + Math.random() * 24) + '%',
        category: detectCategory(lowerDesc)
    };
}

function detectCategory(desc) {
    if (desc.includes('road') || desc.includes('pothole') || desc.includes('crack')) return 'Road Damage';
    if (desc.includes('flood') || desc.includes('water') || desc.includes('drain') || desc.includes('sewage')) return 'Flooding / Drainage';
    if (desc.includes('light') || desc.includes('lamp') || desc.includes('electric') || desc.includes('power')) return 'Electrical';
    if (desc.includes('tree') || desc.includes('fallen')) return 'Fallen Tree';
    if (desc.includes('garbage') || desc.includes('trash') || desc.includes('waste')) return 'Sanitation';
    if (desc.includes('bridge') || desc.includes('wall') || desc.includes('building')) return 'Structural';
    return 'Infrastructure';
}

function formatDate(isoString) {
    return window.ManilaDates.format(isoString) || 'Not recorded';
}

function statusBadge(status) {
    const map = {
        pending: { color: 'var(--color-status-pending, var(--color-warning))', bg: 'var(--color-status-pending-bg, var(--color-warning-subtle))', border: 'var(--color-warning-border, transparent)', label: 'Pending' },
        ongoing: { color: 'var(--color-status-ongoing, var(--color-info))', bg: 'var(--color-status-ongoing-bg, var(--color-info-subtle))', border: 'var(--color-accent-border, transparent)', label: 'Ongoing' },
        resolved: { color: 'var(--color-status-resolved, var(--color-success))', bg: 'var(--color-status-resolved-bg, var(--color-success-subtle))', border: 'var(--color-success-border, transparent)', label: 'Resolved' }
    };
    map.rejected = { color: 'var(--color-status-rejected, var(--color-danger))', bg: 'var(--color-status-rejected-bg, var(--color-danger-subtle))', border: 'var(--color-danger-border, transparent)', label: 'Rejected' };
    const s = map[status] || { color: 'var(--text-dim)', bg: 'var(--surface)', border: 'var(--border, transparent)', label: 'Unknown status' };
    return `<span style="color:${s.color}; background:${s.bg}; padding:3px 10px; border-radius:20px; font-size:0.75rem; font-weight:600;">${s.label}</span>`;
}

function priorityBadge(priority) {
    const map = {
        Critical: { color: 'var(--color-text-primary, var(--color-danger))', bg: 'var(--color-priority-critical-bg, var(--color-danger-subtle))', border: 'var(--color-danger-border, transparent)' },
        High: { color: 'var(--color-text-primary, var(--color-warning))', bg: 'var(--color-priority-high-bg, var(--color-warning-subtle))', border: 'var(--color-warning-border, transparent)' },
        Medium: { color: 'var(--color-text-primary, var(--color-warning))', bg: 'var(--color-priority-medium-bg, var(--color-warning-subtle))', border: 'var(--color-warning-border, transparent)' },
        Low: { color: 'var(--color-text-primary, var(--color-info))', bg: 'var(--color-priority-low-bg, var(--color-info-subtle))', border: 'var(--color-accent-border, transparent)' }
    };

    const normalized = String(priority ?? '').trim().toLowerCase();
    const label = Object.keys(map).find(
        key => key.toLowerCase() === normalized
    );

    const p = map[label];
    if (!p) return '';

    return `<span style="color:${p.color}; background:${p.bg}; padding:3px 10px; border-radius:20px; font-size:0.75rem; font-weight:600;">${label}</span>`;
}

function normalizeClassification(classification) {
    return window.ReportVocabulary.classification(classification);
}

function classificationBadge(classification) {
    const norm = normalizeClassification(classification);
    if (norm === 'MAJOR') {
        return `<span style="color:var(--accent-pink); font-weight:700;">MAJOR</span>`;
    }
    if (norm === 'MINOR') {
        return `<span style="color:var(--accent-blue);">MINOR</span>`;
    }
    return `<span style="color:var(--text-dim); font-weight:600;">UNCLASSIFIED</span>`;
}

if (typeof window !== 'undefined') {
    window.normalizeClassification = normalizeClassification;
    window.classificationBadge = classificationBadge;
    window.getAllReports = getAllReports;
    window.filterReports = filterReports;
    window.formatDate = formatDate;
    window.statusBadge = statusBadge;
    window.priorityBadge = priorityBadge;
}
if (typeof globalThis !== 'undefined') {
    globalThis.normalizeClassification = normalizeClassification;
    globalThis.classificationBadge = classificationBadge;
    globalThis.getAllReports = getAllReports;
    globalThis.filterReports = filterReports;
    globalThis.formatDate = formatDate;
    globalThis.statusBadge = statusBadge;
    globalThis.priorityBadge = priorityBadge;
    globalThis.getAuthorizedReport = getAuthorizedReport;
    globalThis.reportCategoryOriginMarkup = reportCategoryOriginMarkup;
    globalThis.reportDetailsUrl = reportDetailsUrl;
}

function aiDetailsMarkup(report) {
    if (report.originalAi) return submissionAssessmentMarkup(report);
    if (!report.visionDetected) return '';
    const photos = Array.isArray(report.aiPhotoDetails) ? report.aiPhotoDetails : [];
    const detections = photos.flatMap(photo => photo?.detections || []);
    const model = window.ReportVocabulary.reportModelDisplayName(report);
    return `
        <div style="background:var(--color-legacy-ai-bg, var(--color-accent-subtle)); solid var(--color-legacy-ai-border, var(--color-accent-border)); border-radius:8px; padding:12px;">
            <div style="font-size:0.78rem; font-weight:700; color:var(--accent-blue); margin-bottom:7px;">AI Scan Details</div>
            <div style="font-size:0.78rem; color:var(--text-dim); line-height:1.6;">
                <div><strong>Model:</strong> ${reportAssessmentText(model || 'Not reported')}${report.aiTask ? ` · <strong>Task:</strong> ${reportAssessmentText(report.aiTask)}` : ''}</div>
                ${report.aiSummary ? `<div><strong>Summary:</strong> ${report.aiSummary}</div>` : ''}
                ${report.aiSceneMatch ? `<div><strong>Photo scene match:</strong> ${report.aiSceneMatch.score}%</div>` : ''}
                <div><strong>Detections:</strong> ${detections.length ? detections.map(d => `${d.damageType || 'Damage'} (${d.confidence || 0}%)${d.severity ? ` — ${d.severity}` : ''}`).join('; ') : 'Primary damage detected'}</div>
            </div>
        </div>`;
}

function reportAssessmentText(value) {
    return String(value ?? 'Not available').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function reportCategoryOriginMarkup(report) {
    if (!report.originalAi) return '';
    const corrected = report.citizenCategory && report.originalAi.suggested_category && report.citizenCategory !== report.originalAi.suggested_category;
    const label = corrected ? 'Citizen correction' : report.citizenCategory ? 'Citizen category' : 'Category not selected';
    return `<small class="report-category-origin">${label}</small>`;
}

function reportDetailsUrl(report) {
    const id = report.backendId ?? (/^\d+$/.test(String(report.id)) ? report.id : null);
    return /^[1-9]\d*$/.test(String(id)) && Number.isSafeInteger(Number(id)) ? `report-details.html?id=${id}` : null;
}

function submissionAssessmentMarkup(report) {
    const ai = report.originalAi;
    if (!ai) return '';
    const model = window.ReportVocabulary.reportModelDisplayName(report);
    const confidence = value => value == null ? 'Not available' : `${Math.round(value * 10000) / 100}%`;
    const row = (label, value) => `<dt>${label}</dt><dd>${reportAssessmentText(value)}</dd>`;
    const correction = report.citizenCategory && ai.suggested_category && report.citizenCategory !== ai.suggested_category;
    return `<section class="submission-assessment" data-submission-assessment>
        <h3>AI Detection and Citizen Category</h3>
        <dl>${row('AI Detection', ai.status)}
            ${row('Original Canonical Class', ai.canonical_class)}
            ${!ai.detected && ai.candidate ? row('Provisional Candidate', ai.candidate.canonical_class) : ''}
            ${row('Original AI Confidence', confidence(ai.confidence))}
            ${model ? row('AI Model', model) : ''}
            ${row('AI-Suggested Category', ai.suggested_category)}
            ${row('Citizen Report Category', report.citizenCategory || 'Not selected')}
            ${row('Barangay Review Status', report.status)}
            ${(ai.photos || []).map((photo, index) => row(`Photo ${index + 1}`, `${photo.status}; ${photo.canonical_class || photo.candidate?.canonical_class || 'No canonical class'}; ${confidence(photo.confidence)}`)).join('')}
        </dl>${correction ? '<p class="assessment-note">Citizen category differs from the original AI suggestion.</p>' : ''}
    </section>`;
}

function seedDemoReports() {
    if (getAllReports().length > 0) return;
    const demos = [
        { description: 'Large pothole on main road near market causing accidents', barangay: 'Barangay 1', submittedBy: 'demo_citizen', submittedById: 'demo1', location: 'Main St., Zone 2', lat: 10.3157, lng: 123.8854 },
        { description: 'Broken street lamp at corner of Rizal and Mabini St.', barangay: 'Barangay 1', submittedBy: 'demo_citizen', submittedById: 'demo1', location: 'Rizal St., Zone 1', lat: 10.3160, lng: 123.8860 },
        { description: 'Flooding near school — drainage blocked by garbage', barangay: 'Barangay 2', submittedBy: 'demo_citizen2', submittedById: 'demo2', location: 'School Area', lat: 10.3200, lng: 123.8950 },
        { description: 'Fallen tree blocking road after last night storm', barangay: 'Barangay 2', submittedBy: 'demo_citizen2', submittedById: 'demo2', location: 'Purok 3', lat: 10.3210, lng: 123.8960 },
        { description: 'Road crack spreading along barangay road near chapel', barangay: 'Barangay 3', submittedBy: 'demo_citizen3', submittedById: 'demo3', location: 'Zone 5', lat: 10.3057, lng: 123.8854 },
        { description: 'Overflowing garbage bins near public market', barangay: 'Barangay 4', submittedBy: 'demo_citizen4', submittedById: 'demo4', location: 'Public Market', lat: 10.3100, lng: 123.8950 },
        { description: 'Damaged bridge railing is dangerous for motorcycles', barangay: 'Barangay 5', submittedBy: 'demo_citizen5', submittedById: 'demo5', location: 'Barangay Bridge', lat: 10.3257, lng: 123.8754 },
    ];
    const seeded = demos.map((d, i) => {
        const ai = simulateAI(d.description);
        return {
            id: 'RPT_DEMO_' + i,
            ...d,
            aiClassification: ai.classification,
            aiPriority: ai.priority,
            aiConfidence: ai.confidence,
            aiCategory: ai.category,
            visionDetected: false,
            status: i === 2 ? 'ongoing' : i === 4 ? 'resolved' : 'pending',
            createdAt: new Date(Date.now() - (86400000 * (4 - i))).toISOString(),
            updatedAt: new Date().toISOString()
        };
    });
    saveReports(seeded);
}

getAllReports();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        REPORTS_KEY,
        REPORTS_CONTEXT_KEY,
        clearReportCache,
        getAuthorizedReport,
        reportIsAccessible,
        reportCategoryOriginMarkup,
        reportDetailsUrl,
        normalizeClassification,
        classificationBadge,
        getAllReports,
        saveReports,
        addReport,
        updateReport,
        updateReportStatus,
        syncReportsFromBackend,
        getReportLoadState,
        filterReports,
        formatDate,
        statusBadge,
        priorityBadge,
        seedDemoReports
    };
}
