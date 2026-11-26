# NeighborLens AI — Raw GIS Report Icons

All icons are editable SVG (not raster images), with transparent backgrounds.

- `marker-*.svg` — 48 × 56 report map pins, intended for Leaflet GIS markers.
- `marker-*-selected.svg` — navy highlighted/selected pin variants.
- `icon-*.svg` — 24 × 24 outline category icons for map popups, legends, or report lists.

## Categories
- report: General report
- pothole: Pothole
- road-crack: Road crack
- streetlight: Damaged streetlight
- drainage: Clogged drainage
- major: Major issue
- minor: Minor issue
- resolved: Resolved report

## Design tokens
Blue `#1677FF`, navy `#0B326E`, white `#FFFFFF`. Marker shapes and categories are distinguished primarily by pictograms, not by color alone.

## Leaflet example
```js
const icon = L.icon({ iconUrl: '/assets/maps/marker-pothole.svg', iconSize: [48,56], iconAnchor: [24,48], popupAnchor: [0,-45] });
L.marker([latitude, longitude], { icon }).addTo(map);
```

Animation recommendation: animate a separate CSS wrapper/halo on hover or selection, not the map layer itself; respect `prefers-reduced-motion: reduce`.
