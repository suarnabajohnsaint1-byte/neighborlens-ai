# NeighborLens AI — Admin Login SVG Asset Kit

A set of **editable standalone SVG vectors** recreated to match the approved desktop **Admin Login** screenshot. The reference image is a raster graphic; its original vector source cannot be extracted exactly. These assets are **new vector recreations**, not pixel-identical traced originals. The Bacolod-inspired city hall illustration is stylized and must not be treated as a precise architectural depiction.

## Contents

| Folder | Contents |
|---|---|
| `assets/brand/` | Text-only logo/wordmark (header icon intentionally omitted per approved latest version) |
| `assets/icons/` | Outline SVGs with `currentColor`, plus the three filled square feature icons |
| `assets/illustrations/` | Full cityscape background, city hall, clouds, skyline, landscape trees, church, Philippine flag, security badge, and additional access illustration |
| `assets/states/` | SVGs for success, access denied, two-factor and error states |
| `assets/compositions/` | Standalone editable SVG mockup of the full approved desktop login layout |
| `css/admin-login-preview.css` | Responsive standalone preview styles; adapt instead of overwriting project theme |
| `preview.html` | Standalone visual demo using real individual SVG files, no frontend framework |
| `previews/desktop-vector-preview.png` | Rendered full-page SVG mockup preview |
| `icons-gallery.html` | List of available icons |
| `reference/approved-admin-login-raster.png` | The provided reference picture for side-by-side visual comparison only |
| `asset-manifest.json` | Machine-readable asset paths |

## Quick preview

Open `preview.html` in your browser. This is a **visual preview only**; Sign In deliberately does not authenticate. The backend must be wired to the existing auth service. `icons-gallery.html` shows the icons. No npm or Vite needed.

## Integration with the existing Vanilla JS app

1. Copy desired SVGs to your project's `frontend/assets/admin-login/` (or the project's established assets directory).
2. Reference images as static assets: `<img src="assets/admin-login/icons/user.svg" alt="">` or `background-image: url(...)`.
3. Import desired CSS under existing `theme.css`. Map tokens to your current project's `--color-*` scheme; keep CSS scoped to the Admin Login page.
4. Use real form validation, existing `POST /api/auth/login` and server role checks. Do **not** implement mocked successful admin logins.
5. The reference board also depicted optional MFA/password reset; only enable them after checking actual server support. The provided SVG badges are **visual assets, not implemented MFA flows**.
6. `assets/brand/neighborlens-wordmark.svg` is intentionally text-only. The latest approved reference removed the separate upper-left purple icon.
7. Main city backdrop can be used with `background-size:cover; background-position:center bottom`, keeping title/form in HTML on top. Do not put live form fields inside SVG artwork.

## Asset editing notes

- All SVG files are valid XML, with viewBox and no external image URL dependencies.
- The outline icon files use `currentColor`; CSS controls their color when SVGs are inline. When used as an `<img>`, they inherit no CSS color from outside; `filter` may be used or SVG inlining is recommended.
- Illustration SVGs use their own flat color fills and occasional subtle gradients.
- Wordmark SVG uses editable `<text>` rather than embedded fonts. The displayed font may vary by system. Match your app typography with HTML where precise font matching matters.
- The supplied raster reference is not part of the vector asset set.
- No real user data, API keys, or authentication tokens are included.

## Limitations

No original design-file layers exist in the screenshot. This ZIP therefore recreates the icons/illustrations as genuine paths and shapes, not a vectorized copy of the screenshot. The original image is in `reference/` for fidelity checks. Some decorative background objects are artistic approximations.
