const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const root = {
  ManilaDates: require('../../shared/manilaDates'),
  ReportVocabulary: require('../../shared/reportVocabulary'),
  ReportPresentation: require('../../frontend/js/shared/reportPresentation')
};
vm.runInNewContext(fs.readFileSync('frontend/js/shared/reportGisPresentation.js', 'utf8'), { window: root });
const view = root.ReportGisPresentation;
const document = { createElement: tag => ({ tag, children: [], textContent: '', dataset: {}, attributes: {}, listeners: {},
  classList: { add() {} }, setAttribute(key, value) { this.attributes[key] = value; },
  append(...items) { this.children.push(...items); }, replaceChildren(...items) { this.children = items; },
  addEventListener(key, handler) { this.listeners[key] = handler; },
  set innerHTML(value) { throw new Error('Unsafe HTML assignment.'); }
}) };
const walk = element => [element, ...element.children.flatMap(walk)];
const text = element => walk(element).map(node => node.textContent).join(' ');
test('shared GIS popup renders untrusted report fields only as safe text nodes', () => {
  const popup = view.popup(document, { id: 12, category: '<img src=x onerror=alert(1)>', location: '<script>alert(2)</script>', description: '<svg onload=alert(3)>', status: 'pending' }, () => {});
  assert.match(text(popup), /<img src=x onerror=alert\(1\)>/);
  assert.match(text(popup), /<script>alert\(2\)<\/script>/);
  assert.match(text(popup), /<svg onload=alert\(3\)>/);
  assert.ok(walk(popup).every(node => !['script', 'img', 'svg'].includes(node.tag)));
});
test('shared GIS popup preserves actual status, classification, priority, location and timestamp', () => {
  const popup = view.popup(document, { id: 7, category: 'Road Damage', damageType: 'pothole', status: 'resolved', classification: 'MAJOR', priority: 'Low', barangay: 'Barangay 1', createdAt: '2026-10-18T01:00:00Z', description: 'Actual description' }, () => {});
  for (const expected of ['Pothole', 'Road Damage', 'Resolved', 'Barangay 1', 'Actual description']) assert.ok(text(popup).includes(expected));
  assert.doesNotMatch(text(popup), /Major|Low/);
  assert.equal(walk(popup).filter(node => node.tag === 'time').length, 1);
});
for (const [status, icon, label] of [['pending', 'clock', 'Pending'], ['ongoing', 'refresh', 'Ongoing'], ['resolved', 'check-circle', 'Resolved'], ['rejected', 'close', 'Rejected']]) {
  test(`shared GIS ${status} legend, marker and popup all expose the same icon and label`, () => {
    const chip = view.statusElement(document, status);
    assert.equal(chip.dataset.status, status); assert.equal(chip.children[1].textContent, label);
    assert.equal(chip.children[0].className, `gis-icon gis-icon--${icon}`);
    assert.equal(chip.children[0].attributes['aria-hidden'], 'true');
    const marker = view.marker({ id: 4, damageType: 'road_crack', category: 'Road Damage', status });
    assert.ok(marker.label.includes(label)); assert.ok(marker.html.includes(`gis-icon--${icon}`));
  });
}
test('manual report category controls icon and title when the original prediction differs', () => {
  const result = view.type({ id: 5, category: 'Street Light Damage', damageType: 'pothole' });
  assert.equal(result.icon, 'streetlight'); assert.equal(result.title, 'Street Light Damage');
});
test('overlapping GIS reports retain supplied category icons with a separate exact count', () => {
  const group = view.cluster(['pothole', 'pothole', 'clogged_drainage'].map((damageType, id) => ({ id, damageType, barangay: 'Villamonte' })));
  assert.match(group.html, /gis-icon--pothole/); assert.match(group.html, /gis-icon--drainage/);
  assert.equal((group.html.match(/gis-icon--pothole/g) || []).length, 1);
  assert.match(group.html, /gis-cluster-count">3</); assert.match(group.label, /3 reports in Villamonte:.*2 Pothole/);
  const unknown = view.cluster([{ id: 1, category: '<script>bad()</script>' }, { id: 2 }]);
  assert.match(unknown.html, /gis-icon--report/); assert.doesNotMatch(unknown.html, /<script>|bad\(\)/);
});
test('all four canonical damage classes have distinct domain-specific SVG category icons', () => {
  const expected = { pothole: 'pothole', road_crack: 'road-crack', broken_streetlight: 'streetlight', clogged_drainage: 'drainage' };
  for (const [damageType, icon] of Object.entries(expected)) {
    assert.equal(view.type({ damageType }).icon, icon);
    const svg = fs.readFileSync(`frontend/assets/icons/neighborlens_gis_report_icons/icon-${icon}.svg`, 'utf8');
    assert.match(svg, /viewBox="0 0 24 24"/); assert.doesNotMatch(svg, /gradient|filter|foreignObject|script/);
  }
});
test('unknown data is explicit and cannot choose arbitrary SVG paths or fabricate dates', () => {
  const marker = view.marker({ id: 9, category: '__proto__', damageType: '<img>', status: 'not-real' });
  assert.ok(marker.label.includes('Status unavailable')); assert.ok(marker.html.includes('gis-icon--location-pin'));
  const popup = view.popup(document, { id: 9 }, () => {});
  assert.ok(text(popup).includes('Category unavailable')); assert.equal(walk(popup).filter(node => node.tag === 'time').length, 0);
});
test('shared GIS legend includes exactly four statuses and detail action passes the actual report ID', () => {
  const element = document.createElement('div'); element.ownerDocument = document; view.legend(element);
  assert.deepEqual(element.children.map(node => node.dataset.status || node.dataset.classification), ['pending', 'ongoing', 'resolved', 'rejected', 'major', 'minor']);
  assert.equal(element.attributes.role, 'group');
  let selected;
  const popup = view.popup(document, { id: 17, status: 'ongoing' }, id => { selected = id; });
  walk(popup).find(node => node.tag === 'button').listeners.click(); assert.equal(selected, 17);
});

test('Bacolod map has exactly one polygon or multipolygon for each supported barangay', () => {
  const boundaries = require('../../frontend/assets/bacolod-barangay-boundaries.json');
  const map = { addEventListener() {} };
  vm.runInNewContext(fs.readFileSync('frontend/js/map/geofence.js', 'utf8'), { window: map });
  assert.equal(boundaries.features.length, 61);
  assert.equal(new Set(boundaries.features.map(feature => feature.properties.code)).size, 61);
  assert.deepEqual(boundaries.features.map(feature => feature.properties.name).sort(), [...map.BACOLOD_BARANGAYS].sort());
  for (const { geometry } of boundaries.features) {
    assert.ok(['Polygon', 'MultiPolygon'].includes(geometry.type));
    const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
    for (const polygon of polygons) {
      for (const ring of polygon) {
        assert.ok(ring.length >= 4);
        assert.deepEqual(ring[0], ring.at(-1));
        assert.ok(ring.every(([lng, lat]) => lng > 122.85 && lng < 123.15 && lat > 10.5 && lat < 10.8));
      }
    }
  }
});
