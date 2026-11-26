/* Shared GeoJSON containment for the Bacolod service area. */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.GeoContainment = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    const finite = value => typeof value === 'number' && Number.isFinite(value);
    const valid = (lat, lng) => finite(lat) && finite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
    const same = (a, b) => a[0] === b[0] && a[1] === b[1];

    function ringsFor(value) {
        const geometry = value?.type === 'Feature' ? value.geometry : value;
        const polygons = geometry?.type === 'Polygon' ? [geometry.coordinates]
            : geometry?.type === 'MultiPolygon' ? geometry.coordinates : null;
        if (!Array.isArray(polygons) || !polygons.length) return null;
        for (const polygon of polygons) {
            if (!Array.isArray(polygon) || !polygon.length) return null;
            for (const ring of polygon) {
                if (!Array.isArray(ring) || ring.length < 4 ||
                    !ring.every(point => Array.isArray(point) && valid(point[1], point[0])) ||
                    !same(ring[0], ring[ring.length - 1])) return null;
                const [originX, originY] = ring[0];
                const area = ring.slice(1).reduce((sum, [x, y], i) =>
                    sum + (ring[i][0] - originX) * (y - originY) - (x - originX) * (ring[i][1] - originY), 0);
                if (area === 0) return null;
            }
        }
        return polygons;
    }

    function inspect(lat, lng, value) {
        const polygons = ringsFor(value);
        if (!valid(lat, lng) || !polygons) return null;
        // Local tangent-plane approximation for distance to a nearby edge.
        const longitudeScale = 111195 * Math.cos(lat * Math.PI / 180);
        let minDistance = Infinity;
        let inside = false;
        for (const polygon of polygons) {
            const hits = polygon.map(ring => {
                let hit = false;
                for (let i = 1; i < ring.length; i++) {
                    const [x, y] = ring[i];
                    const [prevX, prevY] = ring[i - 1];
                    if ((y > lat) !== (prevY > lat) && lng < (prevX - x) * (lat - y) / (prevY - y) + x) hit = !hit;
                    const ax = (prevX - lng) * longitudeScale;
                    const ay = (prevY - lat) * 111195;
                    const dx = (x - prevX) * longitudeScale;
                    const dy = (y - prevY) * 111195;
                    const fraction = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy || 1)));
                    minDistance = Math.min(minDistance, Math.hypot(ax + fraction * dx, ay + fraction * dy));
                }
                return hit;
            });
            inside ||= hits[0] && !hits.slice(1).some(Boolean);
        }
        return { inside, edgeMeters: minDistance };
    }

    return { valid, inspect };
});
