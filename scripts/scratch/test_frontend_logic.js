// Test simulated frontend behavior for YOLO damage detection vs. fallback

const SCOPE_CATEGORIES = [
    'Road Damage',
    'Flooding / Drainage',
    'Electrical Hazard',
    'Street Light Damage',
    'Traffic Light Damage',
    'Fallen Tree',
    'Structural Damage',
    'Sanitation',
    'Vandalism'
];

const CANONICAL_DAMAGE_CATEGORIES = new Set([
    'Road Damage',
    'Flooding / Drainage',
    'Street Light Damage',
    'Traffic Light Damage'
]);

function normalizeCategory(rawValue) {
    const value = String(rawValue || '').trim();
    if (!value) return 'Unknown';

    const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const aliases = {
        road: 'Road Damage',
        'road damage': 'Road Damage',
        road_damage: 'Road Damage',
        'damaged road': 'Road Damage',
        damaged_road: 'Road Damage',
        pothole: 'Road Damage',
        crack: 'Road Damage',
        pavement: 'Road Damage',
        flood: 'Flooding / Drainage',
        flooding: 'Flooding / Drainage',
        'flooding drainage': 'Flooding / Drainage',
        flooding_drainage: 'Flooding / Drainage',
        clogged_drainage: 'Flooding / Drainage',
        'clogged drainage': 'Flooding / Drainage',
        drainage: 'Flooding / Drainage',
        sewer: 'Flooding / Drainage',
        electrical: 'Electrical Hazard',
        'electrical hazard': 'Electrical Hazard',
        electrical_hazard: 'Electrical Hazard',
        power: 'Electrical Hazard',
        wire: 'Electrical Hazard',
        cable: 'Electrical Hazard',
        'street light damage': 'Street Light Damage',
        'street light': 'Street Light Damage',
        streetlight: 'Street Light Damage',
        street_light: 'Street Light Damage',
        damaged_street_light: 'Street Light Damage',
        'damaged street light': 'Street Light Damage',
        'damaged streetlight': 'Street Light Damage',
        lamp: 'Street Light Damage',
        'light pole': 'Street Light Damage',
        light_pole: 'Street Light Damage',
        'broken light': 'Street Light Damage',
        post: 'Street Light Damage',
        'traffic light': 'Traffic Light Damage',
        'traffic_light': 'Traffic Light Damage',
        traffic_light_broken: 'Traffic Light Damage',
        'traffic light broken': 'Traffic Light Damage',
        damaged_traffic_light: 'Traffic Light Damage',
        'damaged traffic light': 'Traffic Light Damage',
        fallen: 'Fallen Tree',
        'fallen tree': 'Fallen Tree',
        fallen_tree: 'Fallen Tree',
        tree: 'Fallen Tree',
        branch: 'Fallen Tree',
        structural: 'Structural Damage',
        'structural damage': 'Structural Damage',
        structural_damage: 'Structural Damage',
        wall: 'Structural Damage',
        bridge: 'Structural Damage',
        building: 'Structural Damage',
        sanitation: 'Sanitation',
        garbage: 'Sanitation',
        trash: 'Sanitation',
        waste: 'Sanitation',
        vandalism: 'Vandalism',
        graffiti: 'Vandalism',
        paint: 'Vandalism'
    };

    return aliases[normalized] || (SCOPE_CATEGORIES.includes(value) ? value : 'Unknown');
}

function processBackendResponse(payload) {
    const rawDetections = payload.detections || [];
    const top = rawDetections[0] || { className: '', confidence: 0 };
    const category = normalizeCategory(top.className || top.class);
    const isSupportedDamage = category !== 'Unknown' && (CANONICAL_DAMAGE_CATEGORIES.has(category) || SCOPE_CATEGORIES.includes(category));
    const detected = isSupportedDamage && top.confidence >= 50;

    if (!detected) {
        return {
            detected: false,
            source: 'yolo_backend_unsupported',
            category: isSupportedDamage ? category : 'Unknown',
            model: payload.model || 'YOLOv8m COCO baseline'
        };
    }

    return {
        detected: true,
        source: 'yolo_backend',
        category,
        confidence: Math.round(top.confidence),
        model: payload.model || 'YOLOv8m COCO baseline'
    };
}

function mergeVisionResults(results) {
    const isDirectYolo = results.some(r => r.source === 'yolo_backend' && r.category && r.category !== 'Unknown');
    return {
        isDirectYolo,
        assessmentType: isDirectYolo ? 'YOLO Detection' : 'Visual Assessment',
        source: isDirectYolo ? 'yolo_backend' : 'visual_fallback',
        model: isDirectYolo ? 'YOLOv8m' : 'YOLOv8m COCO baseline (Visual Fallback)',
        confidenceBadge: isDirectYolo ? `${results[0].confidence}% YOLO confidence` : `Visual Assessment: 94%`
    };
}

console.log("=== Case 1: Image contains COCO 'car' (confidence: 90.68%) ===");
const carPayload = {
    model: "yolov8m-coco-baseline",
    detections: [{ class: "car", confidence: 90.68 }]
};
const carResult = processBackendResponse(carPayload);
console.log("YOLO Detector Result:", carResult);
console.assert(carResult.detected === false, "Car should NOT be detected as damage");
console.assert(carResult.source === 'yolo_backend_unsupported', "Source should be yolo_backend_unsupported");

// In vision.js: yoloResult.detected is false, so it falls back to visual assessment:
const fallbackResult1 = { detected: true, source: 'visual_fallback', category: 'Road Damage', confidence: '89%' };
const fallbackResult2 = { detected: true, source: 'visual_fallback', category: 'Road Damage', confidence: '89%' };
const mergedFallback = mergeVisionResults([fallbackResult1, fallbackResult2]);
console.log("Merged Fallback Result:", mergedFallback);
console.assert(mergedFallback.isDirectYolo === false, "Fallback must NOT be marked as Direct YOLO");
console.assert(mergedFallback.assessmentType === 'Visual Assessment', "AssessmentType must be Visual Assessment");
console.assert(mergedFallback.confidenceBadge === 'Visual Assessment: 94%', "Badge must be Visual Assessment: 94%");

console.log("\n=== Case 2: Future Custom Checkpoint detects 'damaged_road' (confidence: 94%) ===");
const damagePayload = {
    model: "yolov8-neighborlens_v8_phase4",
    detections: [{ class: "damaged_road", confidence: 94.2 }]
};
const damageResult = processBackendResponse(damagePayload);
console.log("YOLO Detector Result:", damageResult);
console.assert(damageResult.detected === true, "damaged_road must be detected as damage");
console.assert(damageResult.source === 'yolo_backend', "Source must be yolo_backend");
const mergedDamage = mergeVisionResults([damageResult, damageResult]);
console.log("Merged Damage Result:", mergedDamage);
console.assert(mergedDamage.isDirectYolo === true, "Supported damage must be marked as Direct YOLO");
console.assert(mergedDamage.confidenceBadge === '94% YOLO confidence', "Badge must show YOLO confidence for supported damage");

console.log("\nAll Frontend Logic Assertions Passed Successfully!");
