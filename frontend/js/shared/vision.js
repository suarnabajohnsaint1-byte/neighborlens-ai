// ============================================================
// VISION.JS — Tesseract OCR + YOLO infrastructure-damage detection
// ============================================================

const TESSERACT_CDN = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';

let _worker = null;   // single persistent Tesseract worker
let _workerReady = false;
let _workerLoading = false;
let _workerPromise = null;
let _workerStopping = Promise.resolve();
let recognitionQueue = Promise.resolve();
let identityGeneration = 0;
let identityCancellation = new AbortController();

// ── STEP CALLBACK (set by auth.js to update UI in real-time) ──
// Call vision.onStep('stepOCR', 'done') etc.
window._visionStepCb = null;
function step(id, state, msg) {
    if (window._visionStepCb) window._visionStepCb(id, state, msg);
}

// ── LOAD TESSERACT (singleton, promise-coalesced) ──
async function ensureTesseract() {
    await _workerStopping;
    if (_workerReady && _worker) return _worker;
    if (_workerLoading) return _workerPromise;          // coalesce parallel calls

    _workerLoading = true;
    _workerPromise = (async () => {
        step('stepOCR', 'loading', 'Loading Tesseract OCR…');

        if (!window.Tesseract) {
            await loadScript(TESSERACT_CDN);
        }

        step('stepOCR', 'loading', 'Initializing OCR engine…');
        _worker = await boundedOCR(Tesseract.createWorker('eng', 1, {
            logger: m => {
                if (m.status === 'recognizing text') {
                    step('stepText', 'loading',
                        `Reading text… ${Math.round((m.progress || 0) * 100)}%`);
                }
            }
        }), 60000, worker => worker.terminate());

        _workerReady = true;
        _workerLoading = false;
        step('stepOCR', 'done', ' OCR engine ready');
        return _worker;
    })().catch(error => { _worker = null; _workerReady = false; throw error; })
        .finally(() => { _workerLoading = false; _workerPromise = null; });

    return _workerPromise;
}

window.prepareIdentityOCR = () => ensureTesseract().catch(() => {});

const scriptLoads = new Map();
function loadScript(src) {
    if (scriptLoads.has(src)) return scriptLoads.get(src);
    const promise = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        const timer = setTimeout(() => { s.remove(); scriptLoads.delete(src); reject(new Error('OCR download timed out. Retry when connected.')); }, 20000);
        s.src = src;
        s.onload = () => { clearTimeout(timer); resolve(); };
        s.onerror = () => { clearTimeout(timer); s.remove(); scriptLoads.delete(src); reject(new Error('OCR resources unavailable. Check your connection and retry.')); };
        document.head.appendChild(s);
    });
    scriptLoads.set(src, promise);
    return promise;
}

async function boundedOCR(promise, duration, onLate, signal) {
    let timer;
    let expired = false;
    let cancel;
    try {
        return await Promise.race([
            promise.then(value => {
                if (expired && onLate) Promise.resolve(onLate(value)).catch(() => { });
                return value;
            }),
            new Promise((_, reject) => {
                cancel = () => reject(new Error('Scan cancelled.'));
                if (signal?.aborted) {
                    cancel();
                    return;
                }
                signal?.addEventListener('abort', cancel, { once: true });
                timer = setTimeout(() => {
                    expired = true;
                    reject(new Error('OCR timed out. Retry with a clearer, smaller image.'));
                }, duration);
            })
        ]);
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
    }
}
window.stopIdentityOCR = function ({ cancel = true } = {}) {
    if (cancel) {
        identityGeneration++;
        identityCancellation.abort();
        identityCancellation = new AbortController();
    }
    _workerStopping = _workerStopping.then(async () => {
        let current = _worker;
        try { if (_workerPromise) current = await _workerPromise; } catch { }
        _worker = null; _workerReady = false;
        if (current) await current.terminate();
    }).catch(() => { });
    return _workerStopping;
};
function recognizeText(image, options = {}, timeout = 90000) {
    const { signal } = identityCancellation;
    const job = recognitionQueue.then(async () => {
        if (signal.aborted) throw new Error('Scan cancelled.');
        const worker = await ensureTesseract();
        if (signal.aborted) throw new Error('Scan cancelled.');
        try {
            const result = await boundedOCR(worker.recognize(image, { tessedit_char_whitelist: '', ...options }), timeout, undefined, signal);
            return { ...result, data: { ...result.data, segmentation: options.tessedit_pageseg_mode } };
        }
        catch (error) {
            if (!signal.aborted) await window.stopIdentityOCR({ cancel: false });
            throw error;
        }
    });
    recognitionQueue = job.catch(() => { });
    return job;
}
window.hasScreenContextInIdCapture = async function (frame, recognizedText) {
    try {
        const text = (recognizedText ?? (await recognizeText(frame, { tessedit_pageseg_mode: '11' }, 12000)).data?.text ?? '').toLowerCase();
        const visit = /\bvisit\b/.test(text);
        const share = /\bshare\b/.test(text);
        const save = /\bsave\b/.test(text);
        const searchUi = /\b(?:google images|google lens|search by image|visually similar images|images\.google\.com)\b/.test(text);
        const article = /\b(?:valid\s+(?:government\s+)?ids|image results)\b/.test(text);
        return (visit && share && save) || (searchUi && (visit || share || save)) ||
            (article && visit && (share || save));
    } catch {
        // Missing context is inconclusive. The backend still requires independent fraud approval.
        return false;
    }
};
window.validateIdentityImageFile = async function (file) {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file?.type) || !file.size || file.size > 10 * 1024 * 1024) throw new Error('Use a JPG, PNG or WebP image up to 10 MB.');
    const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    const valid = file.type === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 : file.type === 'image/png' ? [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value) : String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP';
    if (!valid) throw new Error('Image contents do not match a supported image format.');
};

// ── IMAGE HELPERS ──
window.fileToDataUrl = function (file) {
    return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = e => resolve(e.target.result);
        r.onerror = reject;
        r.readAsDataURL(file);
    });
};

function dataUrlToImg(dataUrl) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('Image cannot be decoded. Upload a valid image.'));
        img.src = dataUrl;
    });
}

// Resize image to canvas (keeps memory manageable)
function imgToCanvas(img, maxW = 1000) {
    const scale = Math.min(1, maxW / Math.max(img.width, 1));
    const w = Math.max(1, Math.floor(img.width * scale));
    const h = Math.max(1, Math.floor(img.height * scale));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(img, 0, 0, w, h);
    return c;
}

// Get pixel data from canvas
function getPixels(canvas) {
    return canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
}

// ── CANVAS PRE-PROCESSING FOR OCR ──
// Greyscale + contrast boost — no OpenCV needed
function identityCanvas(img, maxSide = 1400) {
    const scale = Math.min(2, maxSide / Math.max(img.width, img.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(img.width * scale));
    canvas.height = Math.max(1, Math.floor(img.height * scale));
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas;
}

function preprocessForOCR(img, maxSide, isolateDarkInk = false) {
    const c = identityCanvas(img, maxSide);
    const ctx = c.getContext('2d');
    const id = ctx.getImageData(0, 0, c.width, c.height);
    const d = id.data;

    for (let i = 0; i < d.length; i += 4) {
        const g = Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
        // The brightest channel suppresses the colored background behind dark printed digits.
        const v = isolateDarkInk ? (Math.max(d[i], d[i + 1], d[i + 2]) - 130) * 3 + 145
            : g < 128 ? g - 30 : g + 30;
        d[i] = d[i + 1] = d[i + 2] = v;
    }
    ctx.putImageData(id, 0, 0);
    return c;
}

function identityCardArea(img) {
    if (img.height > img.width * 2.5 || img.width > img.height * 2.5) return null;
    const landscape = img.width >= img.height;
    const preview = imgToCanvas(img, 240);
    const { data, width, height } = getPixels(preview);
    const light = new Uint8Array(width * height);
    for (let i = 0; i < light.length; i++) {
        light[i] = .299 * data[4 * i] + .587 * data[4 * i + 1] + .114 * data[4 * i + 2];
    }
    preview.width = preview.height = 1;
    function edges(size, from, to, sample) {
        const marks = [];
        const offset = Math.max(3, Math.round(size * .018));
        for (let position = offset; position < size - offset; position++) {
            let change = 0;
            let strong = 0;
            for (let point = from; point <= to; point++) {
                const difference = sample(position + offset, point) - sample(position - offset, point);
                change += difference;
                strong += Math.sign(difference) * (Math.abs(difference) >= 16);
            }
            if (Math.abs(strong) >= (to - from + 1) * .58) marks.push({ position, change: change / (to - from + 1) });
        }
        return marks;
    }
    function strongestPair(marks, min, max) {
        let pair = null;
        let score = 0;
        for (const start of marks) {
            for (const end of marks) {
                const distance = end.position - start.position;
                if (distance < min || distance > max || start.change * end.change >= 0) continue;
                const strength = Math.min(Math.abs(start.change), Math.abs(end.change));
                if (strength > score) {
                    score = strength;
                    pair = [start.position, end.position];
                }
            }
        }
        return score >= 18 ? pair : null;
    }
    const horizontal = edges(height, Math.round(width * .19), Math.round(width * .81), (y, x) => light[y * width + x]);
    const vertical = strongestPair(horizontal, width * (landscape ? .26 : .37), width * .74);
    if (!vertical) return null;
    const [top, bottom] = vertical;
    const middle = Math.round((bottom + top) / 2);
    const interior = Math.round((bottom - top) * .29);
    const sides = edges(width, middle - interior, middle + interior, (x, y) => light[y * width + x]);
    const horizontalBounds = strongestPair(sides, (bottom - top) * 1.3, (bottom - top) * 1.95);
    if (landscape && !horizontalBounds) return null;
    const [left, right] = horizontalBounds || [0, width];
    const pad = Math.round(width * .035);
    if (landscape && right - left + pad * 2 >= width && bottom - top + pad * 2 >= height) return null;
    return [
        Math.max(0, left - pad) / width,
        Math.max(0, top - pad) / height,
        Math.min(width, right + pad) / width,
        Math.min(height, bottom + pad) / height
    ];
}

function cropIdentityImage(img, [left, top, right, bottom], maxSide) {
    const width = (right - left) * img.width;
    const height = (bottom - top) * img.height;
    const scale = maxSide ? Math.min(3, maxSide / Math.max(width, height)) : 1;
    const crop = document.createElement('canvas');
    crop.width = Math.max(1, Math.round(width * scale));
    crop.height = Math.max(1, Math.round(height * scale));
    crop.getContext('2d').drawImage(img, left * img.width, top * img.height, width, height, 0, 0, crop.width, crop.height);
    return crop;
}

// ── CANVAS CARD-SHAPE DETECTION (pure JS) ──
// Scans for a dominant rectangular region via edge pixel counting per row/col
function detectCardShape(img) {
    try {
        const c = imgToCanvas(img, 600);
        const { data, width: w, height: h } = getPixels(c);

        // Sobel-lite: count pixels where neighbouring pixels differ a lot (edges)
        let edgeCount = 0;
        const thresh = 40;

        for (let y = 1; y < h - 1; y++) {
            for (let x = 1; x < w - 1; x++) {
                const idx = (y * w + x) * 4;
                const idxR = (y * w + x + 1) * 4;
                const idxD = ((y + 1) * w + x) * 4;
                const gx = Math.abs(data[idx] - data[idxR]);
                const gy = Math.abs(data[idx] - data[idxD]);
                if (gx + gy > thresh) edgeCount++;
            }
        }

        const edgeDensity = edgeCount / (w * h);
        const aspect = w / h; // canvas was resized from original, but img ratio is preserved

        // ID cards: aspect ~1.2–2.0, meaningful edges from text/photo border
        const aspectOk = img.width / img.height >= 1.1 && img.width / img.height <= 2.2;
        const hasEdges = edgeDensity > 0.03;

        return {
            found: aspectOk && hasEdges,
            aspectRatio: (img.width / img.height).toFixed(2),
            edgeDensity: edgeDensity.toFixed(3),
            isIDRatio: aspectOk
        };
    } catch (e) {
        return { found: false };
    }
}

// ── SKIN-TONE DETECTION (pure JS HSL) ──
// Checks if a portrait-sized skin region exists
function detectSkinRegion(img) {
    try {
        const c = imgToCanvas(img, 500);
        const { data, width: w, height: h } = getPixels(c);
        const total = w * h;
        let skinCount = 0;

        for (let i = 0; i < data.length; i += 4) {
            const r = data[i], g = data[i + 1], b = data[i + 2];
            // Simple RGB skin range (works across various skin tones)
            if (r > 60 && g > 30 && b > 15 &&
                r > g && r > b &&
                (r - Math.min(g, b)) > 10 &&
                Math.max(r, g, b) - Math.min(r, g, b) > 10) {
                skinCount++;
            }
        }

        const ratio = skinCount / total;
        // Portrait photo on ID = 2%–35% skin coverage
        const found = ratio >= 0.02 && ratio <= 0.38;
        return { found, ratio: ratio.toFixed(3) };
    } catch (e) {
        return { found: false, ratio: 0 };
    }
}

// ── SCORE OCR TEXT AGAINST PH GOVERNMENT ID PATTERNS ──
function scoreIDText(rawText) {
    // Normalise common OCR substitutions
    const text = rawText.toUpperCase()
        .replace(/\|/g, 'I').replace(/0/g, 'O').replace(/\$/g, 'S');

    const patterns = [
        { label: 'Republic of the Philippines', re: /REPUBLIC\s+OF\s+THE\s+PHIL/, pts: 30 },
        { label: 'PSA / PhilSys National ID', re: /PHILIPPINE\s+(?:STATISTICS|IDENTIFICATION\s+CARD)|PAMBANSANG\s+PAGKAKAKILANLAN|PHILSYS|NATIONAL\s+ID/, pts: 30 },
        { label: 'Philippine Passport', re: /PASSPORT|PILIPINAS|REPUBLIKA\s+NG/, pts: 30 },
        { label: 'SSS', re: /SOCIAL\s+SECURITY|SOC[\.\s]SEC|\bSSS\b/, pts: 25 },
        { label: 'GSIS / UMID', re: /\bGSIS\b|\bUMID\b|GOVERNMENT\s+SERVICE|UNIFIED\s+MULTI[\s-]*PURPOSE\s+ID/, pts: 25 },
        { label: 'PhilHealth', re: /PHILHEALTH|PHILIPPINE\s+HEALTH/, pts: 25 },
        { label: 'Pag-IBIG / HDMF', re: /PAG.?IBIG|\bHDMF\b|HOME\s+DEVELOPMENT/, pts: 25 },
        { label: "LTO Driver's License", re: /LAND\s+TRANSPORTATION|\bLTO\b|DRIVER.?S?\s+LIC|LICENSE\s+NO/, pts: 25 },
        { label: "COMELEC Voter's ID", re: /COMMISSION\s+ON\s+ELECTIONS|\bCOMELEC\b|VOTER.?S?\s+ID/, pts: 25 },
        { label: 'PRC Professional ID', re: /PROFESSIONAL\s+REGULATION|\bPRC\b/, pts: 20 },
        { label: 'Postal ID', re: /POSTAL\s+ID|PHILIPPINE\s+POSTAL/, pts: 20 },
        { label: 'Senior Citizen / OSCA', re: /SENIOR\s+CITIZEN|\bOSCA\b/, pts: 20 },
        { label: 'PWD ID', re: /PERSONS?\s+WITH\s+DISAB|PWD\s+ID/, pts: 20 },
        { label: 'Date of Birth', re: /DATE\s+OF\s+BIRTH|BIRTHDAY|\bDOB\b|D\.O\.B/, pts: 10 },
        { label: 'Expiry / Validity', re: /EXPIR|VALID\s+UNTIL|VALID\s+THRU/, pts: 10 },
        { label: 'Nationality', re: /NATIONALITY|CITIZENSHIP/, pts: 8 },
        { label: 'Sex / Gender', re: /\bSEX\b|\bGENDER\b|\bFEMALE\b|\bMALE\b/, pts: 6 },
        { label: 'Year value', re: /\b(19[4-9]\d|20[0-3]\d)\b/, pts: 5 },
        { label: 'PhilSys number', re: /\d{4}[\s\-]\d{4}[\s\-]\d{4}/, pts: 15 },
        { label: 'ALL-CAPS name pattern', re: /\b[A-Z]{2,}\s+[A-Z]{2,}\s+[A-Z]{2,}\b/, pts: 8 },
        { label: 'Address field', re: /\bADDRESS\b|\bRESIDENCE\b/, pts: 5 },
    ];

    const hits = [];
    let total = 0;
    for (const p of patterns) {
        if (p.re.test(text)) { hits.push(p.label); total += p.pts; }
    }
    return { score: Math.min(100, total), hits };
}

function extractName(rawText) {
    const t = rawText.toUpperCase();
    const patterns = [
        /\b([A-Z]{2,}),\s*([A-Z]{2,})\s+([A-Z]{2,})\b/,
        /(?:NAME|PANGALAN)\s*[:\-]\s*([A-Z ,\.]{6,})/,
    ];
    for (const p of patterns) {
        const m = t.match(p);
        if (m) return m[0].replace(/^(NAME|PANGALAN)\s*[:\-]\s*/i, '').trim().slice(0, 60);
    }
    return null;
}

// ─────────────────────────────────────────────────────────────
// MAIN EXPORT: verifyGovernmentID
// Steps are reported via window._visionStepCb in real-time
// ─────────────────────────────────────────────────────────────
function identityWords(data, region = 'document') {
    const words = data.words || (data.blocks || []).flatMap(block =>
        (block.paragraphs || []).flatMap(paragraph =>
            (paragraph.lines || []).flatMap(line => line.words || [])
        )
    );
    return words.slice(0, 2000).map(word => ({
        text: word.text, bbox: word.bbox, confidence: word.confidence, pass: data.segmentation, region
    }));
}

function parseIdentityReading(data) {
    const service = window.IdIdentityService;
    if (!service) return null;
    const words = identityWords(data);
    const fields = service.extractIdentityFields(data.text, words);
    if (!words.length) return fields;
    const lines = service.extractIdentityFields(data.text);
    if (fields.idType !== 'UNKNOWN' && lines.idType !== 'UNKNOWN' && fields.idType !== lines.idType) {
        return service.mergeIdentityReadings(fields, lines);
    }
    if (fields.idType === 'UNKNOWN' && lines.idType !== 'UNKNOWN') return lines;
    for (const key of ['fullName', 'birthDate', 'address']) {
        if (!fields[key] && lines[key]) fields[key] = lines[key];
    }
    if (fields.idType === lines.idType && fields.idType !== 'UNKNOWN') {
        fields.idNumber ||= lines.idNumber;
        fields.expiryDatePresent ||= lines.expiryDatePresent;
        if (!fields.expiryDate && lines.expiryDate) fields.expiryDate = lines.expiryDate;
    }
    return fields;
}

function identityReadScore(data) {
    const fields = parseIdentityReading(data);
    if (!fields) return 0;
    const recognized = fields.idType !== 'UNKNOWN';
    const hasValidity = Boolean(fields.expiryDate) ||
        (fields.expiryDate === null && !fields.expiryDatePresent);
    return Number(recognized) * 2 +
        ['fullName', 'birthDate', 'address'].filter(key => Boolean(fields[key])).length + Number(hasValidity) +
        Number(recognized && Boolean(fields.idNumber));
}

function identityRegionCanvas(img, region, size) {
    const left = Math.max(0, Math.min(img.width - 1, region.left * img.width / size.width));
    const top = Math.max(0, Math.min(img.height - 1, region.top * img.height / size.height));
    const width = Math.min(img.width - left, region.width * img.width / size.width);
    const height = Math.min(img.height - top, region.height * img.height / size.height);
    const scale = Math.min(4, 1600 / Math.max(width, height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(width * scale));
    canvas.height = Math.max(1, Math.floor(height * scale));
    canvas.getContext('2d').drawImage(img, left, top, width, height, 0, 0, canvas.width, canvas.height);
    return canvas;
}

async function readMissingIdentityFields(img, readings, size, current) {
    const service = window.IdIdentityService;
    if (!service) return null;
    const parsed = readings.map(parseIdentityReading);
    const fields = parsed.length > 1 ? service.mergeIdentityReadings(parsed[0], parsed[1]) : parsed[0];
    const regions = new Map();
    for (const data of readings) {
        for (const region of service.identityScanRegions(identityWords(data), size, fields)) {
            if (!regions.has(region.field)) regions.set(region.field, region);
        }
    }
    const labels = { birthDate: 'date of birth', address: 'address', expiryDate: 'expiration date' };
    for (const region of regions.values()) {
        if (current !== identityGeneration) throw new Error('Scan cancelled.');
        let canvas;
        try {
            step('stepText', 'loading', `Reading ${labels[region.field]} from the ID...`);
            canvas = identityRegionCanvas(img, region, size);
            const options = { tessedit_pageseg_mode: '6' };
            if (region.field !== 'address' && fields.idType === 'DRIVERS_LICENSE') options.tessedit_char_whitelist = '0123456789/.- ';
            const { data } = await recognizeText(canvas, options, 20000);
            if (current !== identityGeneration) throw new Error('Scan cancelled.');
            const value = service.readIdentityRegion(region.field, data.text, fields.idType, identityWords(data, region.field));
            if (value) fields[region.field] = value;
        } catch (error) {
            if (current !== identityGeneration) throw error;
            break;
        } finally {
            if (canvas) canvas.width = canvas.height = 1;
        }
    }
    return fields;
}

// These regions follow the printed layout of the physical cards. They are
// used only to recover missing fields after the full image identifies the ID.
const IDENTITY_CARD_REGIONS = {
    PHILSYS: {
        panel: [.42, .28, .76, .72],
        panelAlternate: [.419, .28, .765, .725],
        idNumber: [.065, .267, .43, .382],
        address: [.058, .78, .83, .93],
        addressAlternate: [.055, .778, .835, .935]
    },
    UMID: {
        panel: [.40, .36, .98, .95],
        idNumber: [.585, .304, .954, .367],
        birthDate: [.588, .698, .88, .777]
    }
};

async function recoverCardFields(card, fields, current, documentReadings) {
    const layout = IDENTITY_CARD_REGIONS[fields?.idType];
    if (!card || !layout) return;
    const service = window.IdIdentityService;
    const philSys = fields.idType === 'PHILSYS';
    const empty = key => !fields[key] && !fields.conflicts?.includes(key);
    let parsedDocumentReadings;
    const recoverFromDocument = (field, ...focused) => {
        parsedDocumentReadings ??= documentReadings.map(parseIdentityReading);
        return service.consistentPhilSysDocumentField(parsedDocumentReadings, field, focused);
    };
    if (philSys) {
        // A failed focused read must not expose the less reliable whole-card candidate.
        fields.fullName = '';
        fields.address = '';
    }
    const scanRegion = async (region, { enhanced = false, digits, singleLine = false, isolateDarkInk = false } = {}) => {
        if (current !== identityGeneration) throw new Error('Scan cancelled.');
        const crop = cropIdentityImage(card, region, 1550);
        const image = enhanced ? preprocessForOCR(crop, 1550, isolateDarkInk) : crop;
        try {
            const result = await recognizeText(image, {
                tessedit_pageseg_mode: singleLine ? '7' : '6',
                ...(digits ? { tessedit_char_whitelist: digits } : {})
            }, 15000);
            if (current !== identityGeneration) throw new Error('Scan cancelled.');
            return result.data;
        } finally {
            image.width = image.height = 1;
            crop.width = crop.height = 1;
        }
    };
    try {
        if (philSys || empty('fullName') || empty('birthDate') || empty('address')) {
            step('stepText', 'loading', 'Reading the smaller details on the ID…');
            const data = await scanRegion(layout.panel, { enhanced: true });
            const panel = service.extractIdentityFields(data.text);
            if (philSys) {
                const alternate = await scanRegion(layout.panelAlternate, { enhanced: true });
                const first = service.readIdentityRegion('fullName', data.text, fields.idType, identityWords(data, 'fullName'));
                const second = service.readIdentityRegion('fullName', alternate.text, fields.idType, identityWords(alternate, 'fullName'));
                fields.fullName = service.agreeIdentityField(first, second) ||
                    recoverFromDocument('fullName', first, second);
                if (empty('birthDate') && panel.birthDate && /\b(?:KAPANGANAKAN|DATE\s+OF\s+BIRTH|BIRTH\s+DATE)\b/i.test(data.text)) {
                    fields.birthDate = panel.birthDate;
                }
            } else {
                for (const key of ['fullName', 'birthDate', 'address']) {
                    if (empty(key) && panel[key]) fields[key] = panel[key];
                }
            }
        }
        if (layout.address) {
            const data = await scanRegion(layout.address, { enhanced: true });
            const alternate = await scanRegion(layout.addressAlternate, { enhanced: true, isolateDarkInk: true });
            const first = service.readIdentityRegion('address', data.text, fields.idType, identityWords(data, 'address'));
            const second = service.readIdentityRegion('address', alternate.text, fields.idType, identityWords(alternate, 'address'));
            fields.address = service.corroboratePhilSysAddress(first, second, documentReadings.map(reading => reading.text)) ||
                recoverFromDocument('address', first, second);
        }
        for (const key of ['idNumber', 'birthDate']) {
            if (!layout[key] || !empty(key)) continue;
            const digits = key === 'idNumber' ? '0123456789- ' : '0123456789/.- ';
            const data = await scanRegion(layout[key], {
                digits, singleLine: true, enhanced: fields.idType === 'UMID', isolateDarkInk: key === 'birthDate'
            });
            const value = service.readIdentityRegion(key, data.text, fields.idType);
            if (value) fields[key] = value;
        }
    } catch (error) {
        if (current !== identityGeneration) throw error;
    }
}

window.verifyGovernmentID = async function (file) {
    const current = identityGeneration;
    let img, card, processed, alternate, uncropped, url;
    try {
        await window.validateIdentityImageFile(file);
        if (current !== identityGeneration) throw new Error('Scan cancelled.');
        // ── Step: Read file ──
        step('stepPreproc', 'loading', 'Reading image file…');
        url = URL.createObjectURL(file);
        img = await dataUrlToImg(url);
        if (current !== identityGeneration) throw new Error('Scan cancelled.');
        if (img.width < 320 || img.height < 200 || img.width * img.height > 24000000) throw new Error('Use an ID image at least 320 x 200 pixels and at most 24 megapixels.');
        step('stepPreproc', 'done', ' Image loaded');

        // ── Step: Card shape (instant — pure canvas) ──
        step('stepCard', 'loading', 'Checking card shape…');
        const bounds = identityCardArea(img);
        if (bounds) card = cropIdentityImage(img, bounds);
        const source = card || img;
        const cardResult = detectCardShape(img);
        step('stepCard',
            cardResult.found ? 'done' : 'warn',
            cardResult.found
                ? ` Card shape OK (aspect ${cardResult.aspectRatio}:1)`
                : `Card shape unclear (aspect ${cardResult.aspectRatio}:1) — ensure ID fills frame`
        );

        // ── Step: Face/portrait (instant — pure canvas) ──
        step('stepFace', 'loading', 'Checking portrait region…');
        const faceResult = detectSkinRegion(img);
        step('stepFace',
            faceResult.found ? 'done' : 'warn',
            faceResult.found
                ? ` Portrait photo region detected`
                : `No portrait detected — ensure the ID photo is visible`
        );

        // ── Step: Preprocess for OCR ──
        step('stepPreproc', 'loading', 'Enhancing image for OCR…');
        processed = preprocessForOCR(source, card ? 2000 : undefined);
        step('stepPreproc', 'done', ' Image enhanced (greyscale + contrast)');

        // ── Step: OCR ──
        step('stepOCR', 'loading', 'Loading Tesseract OCR engine…');
        await ensureTesseract();
        if (current !== identityGeneration) throw new Error('Scan cancelled.');
        step('stepOCR', 'done', ' OCR engine ready');

        step('stepText', 'loading', 'Extracting text from ID…');
        let { data } = await recognizeText(processed, { tessedit_pageseg_mode: '6' });
        const readings = [data];
        if (current !== identityGeneration) throw new Error('Scan cancelled.');
        if (identityReadScore(data) < 7 || !Number.isFinite(data.confidence) || data.confidence < 70) {
            step('stepText', 'loading', 'Reading smaller fields with an alternate local scan...');
            alternate = identityCanvas(source, card ? 2000 : undefined);
            const retry = await recognizeText(alternate, { tessedit_pageseg_mode: '11' });
            if (current !== identityGeneration) throw new Error('Scan cancelled.');
            const firstScore = identityReadScore(data);
            const retryScore = identityReadScore(retry.data);
            if (retryScore > firstScore || (retryScore === firstScore && retry.data.confidence > data.confidence)) {
                readings.unshift(retry.data);
                data = retry.data;
            } else readings.push(retry.data);
        }
        let fields = await readMissingIdentityFields(source, readings, processed, current);
        if (card && fields?.idType === 'UNKNOWN' && !fields.conflicts?.includes('idType')) {
            uncropped = preprocessForOCR(img);
            const retry = await recognizeText(uncropped, { tessedit_pageseg_mode: '11' }, 15000).catch(() => null);
            if (current !== identityGeneration) throw new Error('Scan cancelled.');
            if (retry && identityReadScore(retry.data) > identityReadScore(data)) {
                data = retry.data;
                fields = await readMissingIdentityFields(img, [data], uncropped, current);
                readings.push(data);
                // Full-frame OCR can resolve the type even if cropped text is weak.
                // Keep the detected card for the field-specific reads.
            }
        }
        await recoverCardFields(card, fields, current, readings);
        if (current !== identityGeneration) throw new Error('Scan cancelled.');
        const rawText = data.text || '';
        step('stepText', rawText.length > 10 ? 'done' : 'warn',
            rawText.length > 10
                ? ` Text extracted (${rawText.trim().split(/\s+/).length} words)`
                : 'Little text found — try a sharper, better-lit photo'
        );

        // ── Step: Score ──
        step('stepScore', 'loading', 'Matching PH government ID patterns…');
        const { score: textScore, hits } = scoreIDText(rawText);
        const extractedName = extractName(rawText);

        // Composite scoring
        let totalScore = 0;
        const passed = [], failed = [];

        // OCR text (max 55)
        const ocrPts = Math.min(55, textScore);
        totalScore += ocrPts;
        if (ocrPts >= 20) passed.push(`ID text: ${hits.slice(0, 3).join(', ')}`);
        else failed.push('No valid Philippine government ID text detected');

        // Card shape (max 20)
        const cardPts = (cardResult.found && cardResult.isIDRatio) ? 20 : 0;
        totalScore += cardPts;
        if (cardPts) passed.push('Card shape confirmed');
        else failed.push('Hold the ID flat — it should fill most of the frame');

        // Portrait (max 25)
        const facePts = faceResult.found ? 25 : 0;
        totalScore += facePts;
        if (facePts) passed.push('Portrait photo detected');
        else failed.push('Make sure the face photo on the ID is clearly visible');

        const valid = totalScore >= 55 && textScore >= 20;

        step('stepScore',
            valid ? 'done' : 'fail',
            valid
                ? `Scan score: ${totalScore}/100; review extracted information`
                : `Score: ${totalScore}/100 — verification failed`
        );

        const scoreBreakdown = {
            ocr: { label: 'OCR text match', points: ocrPts, max: 55 },
            card: { label: 'Card shape', points: cardPts, max: 20 },
            face: { label: 'Portrait region', points: facePts, max: 25 }
        };

        return {
            valid,
            confidence: Number.isFinite(data.confidence) ? data.confidence : null,
            score: Math.min(100, totalScore),
            textScore,
            extractedName,
            hits,
            passed,
            failed,
            scoreBreakdown,
            rawText,
            words: identityWords(data),
            fields,
            reason: valid
                ? `Document scan passed (score ${totalScore}/100); authenticity not verified`
                : failed[0] || 'Could not confirm as a valid Philippine government ID'
        };

    } catch (err) {
        if (current === identityGeneration) step('stepScore', 'fail', `Error: ${err.message}`);
        return {
            valid: false,
            error: true,
            score: 0,
            reason: `Scan error: ${err.message}. Please try again with a clearer photo.`,
            details: null
        };
    } finally {
        if (url) URL.revokeObjectURL(url);
        if (processed) processed.width = processed.height = 1;
        if (alternate) alternate.width = alternate.height = 1;
        if (uncropped) uncropped.width = uncropped.height = 1;
        if (card) card.width = card.height = 1;
        if (img) img.src = '';
    }
};

// ─────────────────────────────────────────────────────────────
// ISSUE DETECTION FROM REPORT PHOTO
// Pure Canvas colour analysis + Tesseract text clues
// ─────────────────────────────────────────────────────────────

function analyzeColors(img) {
    try {
        const c = imgToCanvas(img, 400);
        const { data, width: w, height: h } = getPixels(c);
        const total = w * h;

        let water = 0, road = 0, green = 0, yellow = 0;

        for (let i = 0; i < data.length; i += 4) {
            const r = data[i], g = data[i + 1], b = data[i + 2];

            // Blue/grey — water/flooding
            if (b > r && b > g && b > 60) water++;
            // Dark grey — road/asphalt
            if (r < 120 && g < 120 && b < 120 && Math.max(r, g, b) > 20) road++;
            // Green — vegetation/fallen tree
            if (g > r && g > b && g > 50) green++;
            // Yellow/amber — caution/garbage
            if (r > 150 && g > 120 && b < 80) yellow++;
        }

        return {
            waterRatio: water / total,
            roadRatio: road / total,
            greenRatio: green / total,
            yellowRatio: yellow / total
        };
    } catch (e) {
        return { waterRatio: 0, roadRatio: 0, greenRatio: 0, yellowRatio: 0 };
    }
}

function measureEdges(img) {
    try {
        const c = imgToCanvas(img, 400);
        const { data, width: w, height: h } = getPixels(c);
        let edges = 0;
        for (let y = 0; y < h - 1; y++) {
            for (let x = 0; x < w - 1; x++) {
                const i = (y * w + x) * 4;
                const ir = (y * w + x + 1) * 4;
                const id = ((y + 1) * w + x) * 4;
                if (Math.abs(data[i] - data[ir]) + Math.abs(data[i] - data[id]) > 50) edges++;
            }
        }
        return edges / (w * h);
    } catch (e) {
        return 0;
    }
}

const TEXT_KEYWORDS = {
    'pothole': 'Road Damage', 'road': 'Road Damage', 'asphalt': 'Road Damage', 'pavement': 'Road Damage', 'crack': 'Road Damage', 'street': 'Road Damage', 'pit': 'Road Damage',
    'flood': 'Flooding / Drainage', 'water': 'Flooding / Drainage', 'drain': 'Flooding / Drainage', 'puddle': 'Flooding / Drainage', 'sewage': 'Flooding / Drainage', 'overflow': 'Flooding / Drainage', 'waterlog': 'Flooding / Drainage',
    'wire': 'Electrical Hazard', 'electric': 'Electrical Hazard', 'power': 'Electrical Hazard', 'cable': 'Electrical Hazard',
    'lamp': 'Street Light Damage', 'streetlight': 'Street Light Damage', 'street light': 'Street Light Damage', 'light pole': 'Street Light Damage', 'lightpost': 'Street Light Damage', 'damaged light': 'Street Light Damage', 'broken lamp': 'Street Light Damage', 'broken light': 'Street Light Damage',
    'tree': 'Fallen Tree', 'branch': 'Fallen Tree', 'fallen': 'Fallen Tree', 'timber': 'Fallen Tree', 'uprooted': 'Fallen Tree', 'log': 'Fallen Tree', 'storm': 'Fallen Tree',
    'wall': 'Structural Damage', 'building': 'Structural Damage', 'bridge': 'Structural Damage', 'collapse': 'Structural Damage', 'rubble': 'Structural Damage', 'concrete': 'Structural Damage', 'debris': 'Structural Damage',
    'garbage': 'Sanitation', 'trash': 'Sanitation', 'waste': 'Sanitation', 'litter': 'Sanitation', 'dump': 'Sanitation', 'rubbish': 'Sanitation', 'dirty': 'Sanitation',
    'graffiti': 'Vandalism', 'vandal': 'Vandalism', 'spray': 'Vandalism', 'paint': 'Vandalism', 'defaced': 'Vandalism', 'broken glass': 'Vandalism'
};

window.detectIssueFromImage = async function (fileOrDataUrl) {
    try {
        let file = fileOrDataUrl;

        if (typeof fileOrDataUrl === 'string' && fileOrDataUrl.startsWith('data:')) {
            const response = await fetch(fileOrDataUrl);
            const blob = await response.blob();
            file = new File([blob], 'damage-image.jpg', { type: blob.type || 'image/jpeg' });
        }

        if (window.YoloDamageDetector && file) {
            try {
                const yoloResult = await window.YoloDamageDetector.detectDamage(file);
                if (yoloResult && yoloResult.detected && yoloResult.source === 'yolo_backend' && yoloResult.category !== 'Unknown') {
                    return yoloResult;
                }
            } catch (yoloErr) {
                console.warn('[vision] YOLO detector attempt note:', yoloErr.message);
            }
        }

        const dataUrl = typeof fileOrDataUrl === 'string'
            ? fileOrDataUrl
            : await window.fileToDataUrl(fileOrDataUrl);
        const img = await dataUrlToImg(dataUrl);

        // Run colour + edge instantly (canvas-based, synchronous)
        const colors = analyzeColors(img);
        const edgeDensity = measureEdges(img);

        let rawText = '';
        try {
            const worker = await Promise.race([
                ensureTesseract(),
                new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000))
            ]);
            const { data } = await worker.recognize(img);
            rawText = data.text || '';
        } catch (_) {
            // OCR is optional for visual damage detection
        }

        const totalPixels = img.width * img.height || 1;
        const roadRatio = colors.roadPixels / totalPixels;
        const waterRatio = colors.waterPixels / totalPixels;
        const greenRatio = colors.greenPixels / totalPixels;

        const scores = {
            'Road Damage': 0,
            'Flooding / Drainage': 0,
            'Electrical Hazard': 0,
            'Street Light Damage': 0,
            'Fallen Tree': 0,
            'Structural Damage': 0,
            'Sanitation': 0,
            'Vandalism': 0,
        };

        // Text keywords first (highest precision)
        const lowerText = rawText.toLowerCase();
        for (const [kw, cat] of Object.entries(TEXT_KEYWORDS)) {
            if (lowerText.includes(kw)) scores[cat] += 40;
        }

        // Color signatures
        if (roadRatio > 0.18) scores['Road Damage'] += Math.min(35, Math.round(roadRatio * 100));
        if (waterRatio > 0.08) scores['Flooding / Drainage'] += Math.min(45, Math.round(waterRatio * 150));
        if (greenRatio > 0.25) scores['Fallen Tree'] += Math.min(30, Math.round(greenRatio * 70));

        // Edge density
        if (edgeDensity > 0.14) {
            scores['Road Damage'] += 22;
            if (roadRatio < 0.20) scores['Structural Damage'] += 12;
        }
        if (edgeDensity > 0.24) scores['Road Damage'] += 10;

        const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
        const [topCat, topScore] = ranked[0];
        const secondScore = ranked[1]?.[1] || 0;
        const scoreMargin = topScore - secondScore;

        const meta = {
            'Road Damage': { classification: 'MAJOR', priority: 'High' },
            'Flooding / Drainage': { classification: 'MAJOR', priority: 'Critical' },
            'Electrical Hazard': { classification: 'MAJOR', priority: 'Critical' },
            'Street Light Damage': { classification: 'MAJOR', priority: 'High' },
            'Fallen Tree': { classification: 'MAJOR', priority: 'High' },
            'Structural Damage': { classification: 'MAJOR', priority: 'Critical' },
            'Sanitation': { classification: 'MINOR', priority: 'Medium' },
            'Vandalism': { classification: 'MINOR', priority: 'Low' },
        }[topCat] || { classification: 'MINOR', priority: 'Low' };

        const confidence = Math.min(96, Math.max(0, Math.round(topScore * 1.25 + scoreMargin * 0.35)));
        const detected = topScore >= 18 && scoreMargin >= 6;

        const signals = [];
        if (waterRatio > 0.06) signals.push(`water tones ${Math.round(waterRatio * 100)}%`);
        if (roadRatio > 0.15) signals.push(`road surface ${Math.round(roadRatio * 100)}%`);
        if (greenRatio > 0.20) signals.push(`vegetation ${Math.round(greenRatio * 100)}%`);
        if (edgeDensity > 0.10) signals.push(`damage edges ${Math.round(edgeDensity * 100)}%`);
        if (rawText.trim().length > 5) signals.push(`text: "${rawText.trim().slice(0, 40)}"`);

        return {
            detected,
            source: 'visual_fallback',
            assessmentType: 'Visual Assessment',
            model: 'YOLOv8m COCO baseline (Visual Fallback)',
            category: detected ? topCat : 'Unknown',
            classification: meta.classification,
            priority: detected ? meta.priority : 'Low',
            confidence: confidence + '%',
            rawLabels: signals,
            allDetected: signals,
            score: Math.round(topScore),
            margin: Math.round(scoreMargin),
            summary: detected
                ? `${topCat} indicated by visual damage patterns.`
                : 'Image evidence does not conclusively match a supported damage category.'
        };
    } catch (err) {
        console.error('[vision] detectIssueFromImage:', err);
        return {
            detected: false,
            category: 'Unknown',
            confidence: 0,
            rawLabels: [],
            errorCode: err.code || 'SCAN_ERROR',
            errorMessage: err.message || 'Damage detection failed.'
        };
    }
};
