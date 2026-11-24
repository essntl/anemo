# Appearance and profile customisation

Status: built in `feat/appearance-customisation`. This file says what it does and why; the code
says how.

## Goal

Let the owner make Anemo look like theirs: their colours, their fonts, a picture or a moving
background behind the app, frosted-glass panels, and their own name and face next to their
messages. It must stay readable, private (nothing loaded from third parties), cheap on phones
and safe (an uploaded file can never run as a script).

## What the user gets

**Settings → Appearance** (one page, every change shows at once on the whole app, which is the
live preview; a small sample card at the top shows text, a button and a message bubble on the
current background):

1. **Theme**: light / dark / system (existed).
2. **Accent colour**: presets, a colour picker and a hex field, *Reset to default*. Hover and
   pressed shades are derived from it; the text colour on the accent (black or white) is chosen
   for the higher WCAG contrast. If even the better one is under 4.5:1 (or under 3:1 against
   the page, for outlines and icons) the page says so, with the ratio.
3. **Background tint** (optional): a colour mixed into the page, panel and card colours, with a
   strength slider. Text stays the theme's; if a tint makes body text fall under 4.5:1 on the
   panels, a warning shows.
4. **Fonts**: the UI font and the code font, each from: the default, fonts bundled with the
   app, system fonts, or a font file you uploaded (`.woff2`, `.woff`, `.ttf`, `.otf`, up to
   4 MB). Bundled fonts are npm `@fontsource` packages built into the app, so nothing is
   fetched from Google Fonts or any other site. No font-size scale (see *Not built*).
5. **Background**: none, an animated gradient (three built in, drawn by CSS from the accent
   or a fixed palette), or an upload: PNG, JPEG, WebP, AVIF, GIF (still or animated), WebM or
   MP4. Settings: blur, dim (a layer of the page colour over it, so text stays readable in
   light and dark), fit (cover / contain / tile; video tiles as cover). It is behind the whole
   app, so the chat sits right on it.
   - *Animated* sources (video, animated GIF/WebP, gradients) show a still frame when the OS
     asks for reduced motion, pause while the tab is hidden, and on phones (coarse pointer or
     narrow screen) show the still frame unless *Animate on phones too* is on. Video is muted,
     looped, inline, without controls or picture-in-picture.
6. **Frosted glass**: the sidebar, cards, dialogs, menus and the message box become
   translucent with a backdrop blur. Off when the OS asks for reduced transparency, solid
   where `backdrop-filter` isn't supported, a lighter blur on phones. The panel stays at least
   70 % opaque (dark: 65 %) so text keeps its contrast whatever is behind it.
7. **This device**: *Use a different appearance on this device*. When on, this browser keeps
   its own appearance (in localStorage) and neither loads nor saves the server's. Default off:
   the appearance follows you across devices.
8. **Export / import**: a small JSON file with the appearance settings. Uploaded files are
   referenced by id, not included; an import from another server falls back to the defaults
   for files it doesn't have.

**Settings → Profile**: display name (shown instead of the login name) and an avatar. The
avatar is cropped to a square in the browser (drag to move, slider or +/− to zoom, arrow keys
work) and the crop box is sent with the original; the server does the crop and makes 64, 128
and 256 px WebP copies. Without one, initials on the accent colour. The name and avatar show
in the sidebar's account row, next to your chat messages, and next to your prompts on the
Code page.

## Design

### Settings, not a new store

The appearance is the existing `appearance` settings section with new fields (defaults in the
model, so no migration); the profile is a new `profile` section (`display_name`, `avatar_id`).
Both come with `GET /settings` and follow the user across devices. Appearance is not
security-sensitive (no re-auth).

### Uploaded files: one table, files on disk

`appearance_assets` (migration 0075): `kind` (`background`, `font`, `avatar`), `media`
(`image`, `animated`, `video`, `font`), `mime`, `size`, original `filename`, `has_poster`.
Bytes live under `DATA_PATH/appearance/<id>/` (so they are in the backups).

- `POST /api/appearance/assets` (multipart `file`, `kind`) — background or font.
- `GET /api/appearance/assets?kind=` — what's uploaded, for the pickers.
- `GET /api/appearance/assets/{id}/content` (`?variant=poster`, `?size=64|128|256` for avatars).
- `DELETE /api/appearance/assets/{id}` — and the settings that used it go back to the default.
- `PUT /api/appearance/avatar` (multipart `file`, `crop_x`, `crop_y`, `crop_size`, fractions of
  the image) and `DELETE /api/appearance/avatar` — replace or remove the avatar and update the
  profile section in the same transaction (the old avatar's files go).

**Validation is by content, never by name or declared type** (`features/appearance/files.py`):

| Kind | Accepted | How it's checked | Cap | Stored as |
|---|---|---|---|---|
| Image | PNG, JPEG, WebP, AVIF, GIF | Pillow opens and decodes it | 15 MB, 60 MP | still: re-encoded to WebP, longest side ≤ 3840 px, so EXIF/GPS/XMP are dropped; animated: kept as sent, plus a still WebP poster of the first frame |
| Video | WebM, MP4 | EBML header with `webm` doc type; ISO `ftyp` box with a video brand (not AVIF/HEIC) | 40 MB | as sent |
| Font | WOFF2, WOFF, TTF, OTF | magic bytes (`wOF2`, `wOFF`, `\0\1\0\0`/`true`, `OTTO`) | 4 MB | as sent |
| Avatar | the image types | as images | 10 MB | 64/128/256 px WebP |

SVG (and anything that looks like XML or HTML) is refused with its own error code, because an
SVG can carry script. At most 60 uploads are kept.

**Serving**: the stored MIME type (set by us from the sniffed format), `X-Content-Type-Options:
nosniff`, `Content-Security-Policy: default-src 'none'`, `Content-Disposition: inline` with a
safe name, and `Cache-Control: private, max-age=31536000, immutable` (an id's bytes never
change; a new upload gets a new id). Login is required for every route, as for the rest of the
API; Anemo has one user, so "only the owner" is "only someone logged in".

### Applying it: CSS variables on `<html>`, before first paint

`features/appearance/apply.ts` turns the settings into:
- CSS variables for light and dark (`--accent`, `--accent-hover`, `--accent-active`,
  `--accent-contrast`, the tinted `--bg`/`--surface`/`--surface-2`/`--surface-hover`/`--card`,
  `--font-ui`, `--font-code`), and
- data attributes (`data-theme`, `data-density`, `data-glass`).

The background itself is a React component (`AppBackground`, mounted once in `AppLayout`)
with the blur and dim as CSS variables on its own element.

The result is cached in localStorage (`anemo.appearance.css`) and the inline script in
`index.html` copies it onto `<html>` before the app's JS loads, so a reload never flashes the
default colours. It contains no logic of its own (no duplicate of the colour maths). Fonts load
after the JS (bundled ones by a dynamic CSS import, uploaded ones through the `FontFace` API);
until then the fallback in the stack is used (`font-display: swap`). The background media too
appears when the app has started.

### Colour maths

`lib/color.ts`, pure and unit-tested: hex parsing, sRGB ↔ OKLab, mixing in OKLab (the same
space CSS `color-mix(in oklch)` used before, so shades look even), WCAG relative luminance and
contrast ratio, the best text colour on a colour, and the derived shades. Light: hover = mix
toward black 12 %, active 20 %; dark: toward white. The text on the accent is white or
near-black (`#111`), whichever has the higher WCAG contrast on the accent itself. That is a
change: before, a brightness cut-off kept white text on mid colours such as the pink, orange,
green and teal presets, where white has only 3–4:1.

### Glass

A `glass` class on the few containers that should become glass (`Card`, the sidebar, `Dialog`,
`ActionMenu`, `Select`'s list, the `MessageBox` frame). Only with `html[data-glass='on']` does
the class do anything: `background: color-mix(in srgb, var(--surface) var(--glass-opacity),
transparent)` and `backdrop-filter: blur(var(--glass-blur)) saturate(1.3)`. `@supports not
(backdrop-filter …)` and `prefers-reduced-transparency: reduce` keep the solid colour.

## Not built (and why)

- **Font-size scale.** Most text sizes are written in pixels (`text-[13px]`), so scaling the
  root font size would scale spacing but not most text; CSS `zoom` breaks the `100dvh` layout
  and the portalled dialogs. Doing it properly means moving the type scale to rem first.
- **Per-project background.** It would need a project → appearance lookup on every page
  change and a second set of controls; left for later.
- **Metadata stripping for videos and animated images.** That needs re-encoding (ffmpeg, not
  in the image). Still images are re-encoded, so their EXIF is gone.
- **Validating fonts beyond the magic bytes.** The browser's font sanitiser (OTS) checks fonts
  before using them, and they're only ever loaded as fonts.

## Which clients get it

The web app and the installed PWA (phone and desktop) get everything. The browser extension's
side panel is its own small UI and doesn't. **Anemo Voice (Android)** and **Anemo Desktop
(Windows)** are native apps (Kotlin and .NET, no WebView rendering the web UI), so they don't
get it.

## Done when

- Every setting above changes the whole app at once and is still there after a reload,
  without a flash of the default theme, and on another device.
- An SVG, an HTML file renamed `.png`, a font renamed `.mp4` and anything over the caps are
  refused with a clear error; a JPEG with GPS EXIF comes back without it.
- Reduced motion shows a still frame; a hidden tab pauses video; reduced transparency turns
  glass off.
- Name and avatar show in the sidebar, chat and Code page; without an avatar, initials.
- Keyboard: every picker, slider and the avatar cropper work without a mouse, and focus rings
  are visible on any accent.
