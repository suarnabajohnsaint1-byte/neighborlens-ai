// An observation is immutable scan evidence. None of these pixel units are
// accepted as calibrated inspection inputs by the severity policy.
const maskFields = ['candidate_area_px2', 'components', 'crop_fraction', 'largest_component_fraction', 'threshold_stability_iou'];
const fields = {
  road_crack: [...maskFields, 'skeleton_length_px', 'branch_clusters', 'mean_strip_width_px'],
  pothole: [...maskFields, 'largest_contour_circularity'],
  clogged_drainage: maskFields,
  broken_streetlight: ['line_segments', 'longest_line_px']
};
const unusable = new Set(['INVALID_CROP', 'INSUFFICIENT_CONTRAST', 'INSUFFICIENT_DETAIL', 'NO_SEPARABLE_REGION',
  'ANALYZER_BUSY', 'ANALYSIS_UNAVAILABLE', 'ANALYSIS_TIMEOUT']);
const reasons = { road_crack: 'CANDIDATE_MASK_ONLY', pothole: 'CANDIDATE_MASK_ONLY',
  clogged_drainage: 'DRAIN_OPENING_UNVERIFIED', broken_streetlight: 'FIXTURE_CONDITION_UNVERIFIED' };

function readVisualExtent(value, primary, size) {
  const category = primary?.canonical_category;
  if (!value || !primary?.eligible || value.category !== category || !Object.hasOwn(fields, category) ||
      value.source !== 'opencv_visual_extent' || value.version !== '1') return null;
  const { source, version, quality, reason, region, grid, features } = value;
  const header = { source, version, category, quality, reason };
  if (quality === 'UNUSABLE' && unusable.has(reason)) return header;
  if (quality !== 'EXPERIMENTAL' || reason !== reasons[category] || !size ||
      !Array.isArray(region) || region.length !== 4 || !region.every(Number.isSafeInteger) ||
      !Array.isArray(grid) || grid.length !== 2 || !grid.every(v => Number.isInteger(v) && v >= 12 && v <= 320)) return null;
  const [x, y, width, height] = region;
  const box = primary.bounding_box;
  if (!box || x !== Math.floor(box.x) || y !== Math.floor(box.y) || x < 0 || y < 0 ||
      width !== Math.min(size.width, Math.ceil(box.x + box.width)) - x ||
      height !== Math.min(size.height, Math.ceil(box.y + box.height)) - y ||
      width < grid[0] || height < grid[1]) return null;
  if (!features || typeof features !== 'object' || Array.isArray(features)) return null;
  const pixels = grid[0] * grid[1];
  if (Object.entries(features).some(([key, v]) => !fields[category].includes(key) ||
      !Number.isFinite(v) || v < 0 || v > pixels * 4 ||
      (/(fraction|iou|circularity)$/.test(key) && v > 1) ||
      (['candidate_area_px2','components','branch_clusters','line_segments'].includes(key) && !Number.isSafeInteger(v)))) return null;
  if (category === 'broken_streetlight') {
    if (!Object.hasOwn(features, 'line_segments') || (features.line_segments > 0) !== Object.hasOwn(features, 'longest_line_px') ||
        features.longest_line_px > Math.hypot(...grid)) return null;
  } else if (!maskFields.every(key => Object.hasOwn(features, key)) || !(features.candidate_area_px2 > 0 && features.candidate_area_px2 < pixels) ||
      !features.components || features.components > features.candidate_area_px2 ||
      Math.abs(features.crop_fraction - features.candidate_area_px2 / pixels) > 0.000001 ||
      (category === 'road_crack' && (!Object.hasOwn(features, 'branch_clusters') || !Object.hasOwn(features, 'skeleton_length_px')))) return null;
  return { ...header, region, grid, features };
}

module.exports = { readVisualExtent };
