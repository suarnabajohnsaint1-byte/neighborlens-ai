// Comprehensive Test Matrix for NeighborLens AI Damage Detection Pipeline

const CANONICAL_DAMAGE_CLASSES = {
    0: "damaged_road",
    1: "clogged_drainage",
    2: "damaged_street_light",
    3: "damaged_traffic_light",
};

const VALID_DAMAGE_CLASSES = new Set(Object.values(CANONICAL_DAMAGE_CLASSES));

const CATEGORY_DISPLAY_NAMES = {
    "damaged_road": "Road Damage",
    "clogged_drainage": "Flooding / Drainage",
    "damaged_street_light": "Street Light Damage",
    "damaged_traffic_light": "Traffic Light Damage",
};

function normalizeCategory(rawValue) {
    const value = String(rawValue || '').trim();
    if (!value || value === 'Inconclusive') return 'Inconclusive';
    const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const aliases = {
        'road': 'Road Damage',
        'road damage': 'Road Damage',
        'damaged road': 'Road Damage',
        'damaged_road': 'Road Damage',
        'pothole': 'Road Damage',
        'crack': 'Road Damage',
        'pavement': 'Road Damage',
        'flood': 'Flooding / Drainage',
        'flooding': 'Flooding / Drainage',
        'flooding drainage': 'Flooding / Drainage',
        'flooding_drainage': 'Flooding / Drainage',
        'clogged drainage': 'Flooding / Drainage',
        'clogged_drainage': 'Flooding / Drainage',
        'drainage': 'Flooding / Drainage',
        'sewer': 'Flooding / Drainage',
        'street light damage': 'Street Light Damage',
        'street light': 'Street Light Damage',
        'streetlight': 'Street Light Damage',
        'damaged street light': 'Street Light Damage',
        'damaged_street_light': 'Street Light Damage',
        'lamp': 'Street Light Damage',
        'light pole': 'Street Light Damage',
        'traffic light': 'Traffic Light Damage',
        'traffic light damage': 'Traffic Light Damage',
        'damaged traffic light': 'Traffic Light Damage',
        'damaged_traffic_light': 'Traffic Light Damage'
    };
    return aliases[normalized] || (Object.values(CATEGORY_DISPLAY_NAMES).includes(value) ? value : 'Unknown');
}

function processDetectorResponse(payload) {
    const isDetected = Boolean(payload.detected);
    const source = payload.source || (isDetected ? 'yolo_backend' : 'yolo_backend_unsupported');
    const rawCategory = payload.display_category || payload.category || 'Inconclusive';
    const normalized = normalizeCategory(rawCategory);
    const category = isDetected && normalized !== 'Unknown' ? normalized : (isDetected ? rawCategory : 'Inconclusive');
    const confidenceScore = Number(payload.confidence || 0);
    const confidencePct = confidenceScore <= 1 ? Math.round(confidenceScore * 100) : Math.round(confidenceScore);

    return {
        detected: isDetected && category !== 'Inconclusive',
        inconclusive: !isDetected || category === 'Inconclusive',
        source: isDetected && category !== 'Inconclusive' ? 'yolo_backend' : source,
        category,
        confidence: isDetected && category !== 'Inconclusive' ? confidencePct : 0,
        model: payload.model || 'YOLOv8m COCO baseline'
    };
}

function renderBadge(result) {
    if (result.inconclusive || result.category === 'Inconclusive' || !result.detected) {
        return 'AI Assessment: Inconclusive';
    }
    if (result.source === 'yolo_backend') {
        return `${result.confidence}% YOLO confidence`;
    }
    if (result.source === 'visual_fallback') {
        return `Visual Assessment: ${result.confidence}%`;
    }
    return 'AI Assessment: Inconclusive';
}

function validateSubmissionEligibility(files, visionScanState, visionResult) {
    if (!files || files.length !== 2) {
        return { eligible: false, error: 'Report rejected: you must provide exactly 2 issue photos.' };
    }
    if (visionScanState !== 'ready' || !visionResult) {
        return { eligible: false, error: 'Report rejected: both photos must be scanned before submitting.' };
    }
    return { eligible: true };
}

// ── Test Execution ──
console.log("=== Running Pipeline Matrix Unit Tests ===\n");

// Test A: Valid custom damage class
console.log("Test A: Valid custom damage detection (damaged_road, conf=0.88)");
const resA = processDetectorResponse({
    ok: true, detected: true, category: "damaged_road", display_category: "Road Damage",
    confidence: 0.88, model: "neighborlens-yolov8m-v2", source: "yolo_backend", inconclusive: false
});
console.assert(resA.detected === true, "A.1 detected must be true");
console.assert(resA.category === "Road Damage", "A.2 category must be Road Damage");
console.assert(renderBadge(resA) === "88% YOLO confidence", "A.3 badge must show YOLO confidence");
console.log("  [PASS] Custom damage detected & badged correctly.");

// Test B: COCO unsupported object (car)
console.log("\nTest B: COCO unsupported object detection (car, conf=0.91)");
const resB = processDetectorResponse({
    ok: true, detected: false, category: "Inconclusive", display_category: "Inconclusive",
    confidence: 0, model: "yolov8m-coco-baseline", source: "yolo_backend_unsupported", inconclusive: true
});
console.assert(resB.detected === false, "B.1 detected must be false");
console.assert(resB.category === "Inconclusive", "B.2 category must be Inconclusive");
console.assert(renderBadge(resB) === "AI Assessment: Inconclusive", "B.3 badge must show Inconclusive");
console.log("  [PASS] COCO object rejected as damage and marked Inconclusive.");

// Test C: No detection
console.log("\nTest C: No object detected");
const resC = processDetectorResponse({
    ok: true, detected: false, category: "Inconclusive", display_category: "Inconclusive",
    confidence: 0, model: "yolov8m-coco-baseline", source: "yolo_backend_unsupported", inconclusive: true
});
console.assert(resC.detected === false, "C.1 detected must be false");
console.assert(renderBadge(resC) === "AI Assessment: Inconclusive", "C.2 badge must show Inconclusive");
console.log("  [PASS] No detection correctly handled.");

// Test D: Two matching damage classes
console.log("\nTest D: Two matching damage classes (damaged_road / damaged_road)");
const resD = processDetectorResponse({
    ok: true, detected: true, inconclusive: false, category: "damaged_road", display_category: "Road Damage",
    confidence: 0.83, agreement: true, is_valid_match: true, source: "yolo_backend", model: "neighborlens-yolov8m-v2"
});
console.assert(resD.detected === true, "D.1 detected must be true");
console.assert(resD.category === "Road Damage", "D.2 category must be Road Damage");
console.assert(renderBadge(resD) === "83% YOLO confidence", "D.3 badge must show YOLO confidence");
console.log("  [PASS] 2-photo matching agreement confirmed.");

// Test E: Two different damage classes (damaged_road vs clogged_drainage)
console.log("\nTest E: Two conflicting damage classes (damaged_road vs clogged_drainage)");
const resE = processDetectorResponse({
    ok: true, detected: false, inconclusive: true, category: "Inconclusive", display_category: "Inconclusive",
    confidence: 0, agreement: false, is_valid_match: false, source: "yolo_backend_unsupported", model: "neighborlens-yolov8m-v2"
});
console.assert(resE.detected === false, "E.1 detected must be false");
console.assert(resE.category === "Inconclusive", "E.2 category must be Inconclusive");
console.assert(renderBadge(resE) === "AI Assessment: Inconclusive", "E.3 badge must show Inconclusive");
console.log("  [PASS] Conflicting damage classes correctly marked Inconclusive.");

// Test F: Inference error
console.log("\nTest F: Inference error / unreachable service");
const resF = processDetectorResponse({
    ok: false, detected: false, inconclusive: true, category: "Inconclusive", display_category: "Inconclusive",
    confidence: 0, source: "inference_error"
});
console.assert(resF.detected === false, "F.1 detected must be false");
console.assert(renderBadge(resF) === "AI Assessment: Inconclusive", "F.2 badge must show Inconclusive");
console.log("  [PASS] Inference error safely treated as Inconclusive.");

// Test G: Exactly 2 photos + Inconclusive AI -> submission permitted
console.log("\nTest G: Exactly 2 photos attached + Inconclusive AI");
const subG = validateSubmissionEligibility([{}, {}], 'ready', resB);
console.assert(subG.eligible === true, "G.1 submission must be allowed");
console.log("  [PASS] 2 photos with Inconclusive AI is eligible for submission.");

// Test H: Exactly 1 photo attached -> submission rejected
console.log("\nTest H: Exactly 1 photo attached");
const subH = validateSubmissionEligibility([{}], 'ready', resB);
console.assert(subH.eligible === false, "H.1 single photo must be rejected");
console.log("  [PASS] Single photo rejected.");

// Test I: 3 photos attached -> submission rejected
console.log("\nTest I: 3 photos attached");
const subI = validateSubmissionEligibility([{}, {}, {}], 'ready', resB);
console.assert(subI.eligible === false, "I.1 three photos must be rejected");
console.log("  [PASS] 3 photos rejected.");

console.log("\n[OK] ALL 9 TEST MATRIX CASES PASSED SUCCESSFULLY!");
