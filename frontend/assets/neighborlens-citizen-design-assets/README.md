# NeighborLens citizen login design assets

## What is exact
- `01-original/citizen-login-original.png` is the supplied PNG copied byte for byte (1672 × 941).
- `01-original/citizen-login-exact-raster.svg` preserves the full image by embedding that PNG.
- `02-exact-crops` contains native-resolution, unscaled, lossless crops of the visible design in PNG and SVG containers. Each coordinate is recorded in `asset-manifest.json`.
- No image-generation, repainting, resizing or lossy encoding was used for the exact assets.

## What is editable
`03-editable-icons` contains eight manually recreated SVG icons. Their shapes and colors can be edited. They approximate the supplied design and are NOT the original paths or guaranteed pixel matches. Use the exact icon crops when pixel fidelity matters.

## Limits of the source
The uploaded file is a flattened PNG. It contains no original Figma/PSD/AI layers, SVG paths, font files or source components. The original raw editable design cannot be recovered exactly from it. Raster embedded in SVG is still raster and will not gain detail when enlarged.

Illustration crops include visible backgrounds and overlapping objects. For example, the citizen crop includes the street and city behind the person; the city hall crop includes overlapping foreground details. These are reference regions, NOT isolated transparent assets. The backdrop obscured by the login form and text cannot be recovered from this source.

`04-design-reference/tokens.css` provides estimated styling values, not verified original design tokens. The exact reference is the supplied PNG.

For a truly 1:1 editable raw package, provide the original layered Figma, Sketch, PSD, AI, or vector SVG source. This archive includes all pixels supplied and useful visible regions without claiming unavailable source data.

## Contents
- Original PNG and full-layout raster SVG.
- 41 visible-region crops, each as PNG and raster SVG.
- 8 editable vector icon recreations.
- Estimated color/style tokens, a coordinate/asset manifest and this guide.

All assets are self-contained. No external images or fonts are required.
