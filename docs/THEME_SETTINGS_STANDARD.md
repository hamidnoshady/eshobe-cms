# Eshobe CMS — Universal Theme Settings & Typography Development Standard

> **Status: implemented in the CMS, pending deployment and theme adoption.** The manifest parser, save path, `GET /api/site` descriptor, admin UI and compatibility layer now support `type: "responsiveFontSize"` as an additive extension to `contractVersion: 1` (GitHub #209–#212). Do **not** emit the new type from a theme until the CMS version carrying it is deployed to the environment that serves that theme. Track deployment and per-theme adoption in the linked issues.
>
> Canonical references: [Theme API](./THEME_API.md#runtime-settings), [theme deployments](./theme-deployments.md), `src/lib/deploy/theme-settings.ts`, `src/lib/deploy/manifest.ts`, `src/deploy/admin/ThemeSettingsRuntimePanel.tsx`, and [settings-placement rule #156](https://github.com/hamidnoshady/eshobe-cms/issues/156).

## 1. Scope and ownership

- **CMS owns the shared contract, field rendering, validation, persistence, authorization, migrations and preview UX.** Any theme must use this system; a theme may not ship its own tenant-facing admin settings form.
- **Each theme owns the declarative `eshobe.theme.json` schema, defaults, semantic typography roles, CSS token resolver, font assets/licensing and responsive application.** Theme-specific choices belong in its manifest, not hardcoded CMS special cases.
- **Site data wins:** use site + installed theme-package scoping, never a deployment-local value. Redeploy/upgrade/rollback must not reset saved settings or apply new design defaults unless explicitly requested.
- **The standard applies to all themes and site types**, not just architecture/portfolio themes; render only options actually declared by the active theme. Keep built-in/legacy renderers backwards-compatible.
- Preserve the already-shipped placement rule: `group: "design"` appears **one click** from sidebar in **طراحی سایت / Site Design**; `group: "general"` in the visible **تنظیمات پوسته / Theme Settings** page. Never bury them in a site document tab or combine map credentials with typography. Saving one group must not reset another.

## 2. Prefer Payload-native schema and components

Use Payload's official field primitives and `@payloadcms/ui` components, matching the installed Payload version: `number`/`NumberField`, `select`/`SelectField`, `checkbox`, `text`, `row`, `group`, `tabs`, `collapsible`, and admin descriptions/validation. Prefer schema-first rendering or the corresponding Payload UI primitives over handcrafted long stacks of `TextInput` controls. For dynamically declared manifest fields that cannot be registered as static Payload collection fields, use a **single shared schema-to-UI adapter** with official controls; keep the server-side manifest allowlist as the security boundary. Do not synthesize arbitrary Payload component paths supplied by a theme manifest.

UI requirements:
- Divide design into **Typography**, **Colours**, **Layout & Spacing**, **Navigation**, **Motion**, and **Advanced**. Show a compact overview, not a vertical wall of every field; provide tabs/sections, collap­sibles, search/filter by localized label, and sensible advanced defaults.
- Maintain Persian RTL / English LTR labels, accessible keyboard navigation, contrast, focus, help copy, and responsive admin layout. Use standard field errors and explicit save/dirty state; prevent losing unsaved changes on group/device switches.
- Always show units and limits. For numeric fields use real numeric inputs with `min`, `max`, `step`, and server validation. A slider is optional, not the only input.
- Provide **Reset field**, **Reset section**, and deliberate **Restore theme defaults** actions. Never reset other sections or overwrite existing values implicitly.
- Passwords/secrets remain write-only and separate from public design values; preserve tenant authorization and audit behavior.

## 3. Responsive typography — absolute px controls

End users choose typography sizes in **px**, not a multiplier such as `100%` or `1.2x`. Each semantic text role (display, H1, H2, H3, lead, body, summary, UI, navigation, button, card title, home/mobile menus, label, meta, caption) is declared once by the theme, with **independent Desktop / Tablet / Mobile numeric values**. A clear inherited-value state may be used for an unset tablet/mobile override; the UI must distinguish **inherited** from **custom**.

Recommended breakpoints align with the theme's existing CSS breakpoints, not a new CMS-wide requirement to change its layout: Desktop ≥1024 CSS px; Tablet 768–1023 CSS px; Mobile <768 CSS px. The CMS preview selector uses representative viewport widths and does not treat device labels as user-agent detection. Inheritance is Desktop → Tablet → Mobile only when not overridden. Explicit values always win for that breakpoint.

- **Use semantic tokens in components**, never mass inline `font-size` patches. Theme runtime translates validated pixel numbers into safe CSS custom properties under appropriate media queries. Locale and font family may change metrics; keep adequate line-height, text reflow and zoom support.
- A theme may declare optional **Persian/English** locale-specific overrides while retaining a common default. Keep `fa` and `en` direction and font-loading logic safe; do not misrepresent font weights not supplied by the actual font files.
- UI must show a working live sample for each device and, where available, a staging-site preview. Saving changes must revalidate the site's runtime config; **do not deploy/promote production** merely to preview.
- Keep large-text and small-text inputs within accessible, theme-declared safe limits; never inject unsanitized strings into CSS.

### Manifest extension (implemented; deploy before adoption)

Final name and shape, validated by `parseThemeManifest`. The example below is one field per semantic role (not three separate keys per breakpoint) and keeps the existing setting count bounded:

```json
{
  "settings": {
    "fontSizeTitle": {
      "type": "responsiveFontSize",
      "group": "design",
      "category": "typography",
      "section": "headings",
      "labelFa": "اندازه عنوان صفحه",
      "labelEn": "Page title size",
      "unit": "px",
      "default": { "desktop": 42, "tablet": 34, "mobile": 28 },
      "min": 14,
      "max": 80,
      "step": 1,
      "locales": ["fa", "en"]
    }
  }
}
```

`responsiveFontSize`, `unit: "px"`, `category`, `section`, `step`, `locales` and object defaults are now accepted by `parseThemeManifest` under `contractVersion: 1` (additive). Unknown nested keys, non-numeric or out-of-range values, undeclared locales and CSS strings are rejected. The CMS resolves inheritance and locale precedence; `GET /api/site` emits resolved px to the theme. See [THEME_API.md](./THEME_API.md#responsive-typography-type-responsivefontsize).

## 4. Data compatibility and safe rollout

Existing theme manifests use primitive `number` sizes 50–200 where `100` means the original design scale. **Never reinterpret an existing `sizeTitle: 100` as `100px`.** The CMS implements a non-destructive dual-read/new-write policy:

1. Declared scalar settings keep working exactly as before and are still emitted as numbers.
2. A value the current manifest no longer declares, or whose declared type changed, is moved to `site-theme-settings.legacyRuntimeSettings` verbatim. It is never read as px and never emitted to the theme.
3. `runtimeSettingsMeta` records the converter version (`1`), the package and the preserved key list, so a rollout can be audited and a manifest rolled back without losing the values.
4. The new role resolves from the theme default until the customer explicitly saves a px value; that save is the opt-in and clears the preserved copy for that key. There is no automatic percent → px conversion.
5. Theme package sync updates the package row only; it never writes `site-theme-settings`. A regression test pins this.

Migration/rollout requirements:
1. Inventory every installed theme and stored `runtimeSettings` value; the preserved map plus meta column is the backup/provenance record.
2. A setting no longer declared by a new manifest must not silently erase a customer's saved legacy value — covered by the preservation above.
3. A percentage multiplier on a fluid `clamp()` curve cannot be represented exactly by one static px number at all widths; keep old behavior until the customer explicitly changes the setting.
4. Test fresh sites, existing overrides, theme changes, rollback, legacy themes, mixed locales and unknown/malformed settings. Show migration/version state to operators ($212 test suite).
5. Ensure exact per-site isolation, CSRF/session and role checks, save-time validation, cache invalidation and preview isolation. No secrets in public descriptors or generated CSS.

## 5. Acceptance contract for CMS and themes

CMS side (delivered with #209–#212):

- [x] Official Payload controls are used for dynamic fields; responsive values validate as bounded numbers with `px` units.
- [x] Site Design is compact and categorized (Typography, Colours, Layout & Spacing, Navigation, Motion, Advanced) with search, collapsed sections and keyboard-operable controls.
- [x] Independent Desktop / Tablet / Mobile px values work for every declared role, including declared `fa`/`en` overrides, with inherited-vs-custom state and explicit reset.
- [x] Device/locale/section switching preserves pending edits; reset actions are field-, section- or group-scoped with confirmation.
- [x] Missing new settings fall back to the theme's design; legacy percent settings are neither discarded nor interpreted as px.
- [x] Tenant, access-control, secret-handling, manifest parse/validation, rollback and cache invalidation tests cover the change; `GET /api/site` exposes resolved values.
- [ ] Theme side: CSS at 375px, 768px and 1440px matches saved values (headings, menus, forms, cards, prose).
- [ ] Theme side: E2E on an adopting theme in Persian RTL and English LTR, including accessibility and reduced motion.
- [x] `docs/THEME_API.md` and this document describe the shipped contract; per-theme documentation is updated when a theme adopts it.

## Implementation tracking (GitHub)

| Workstream | Issue |
| --- | --- |
| CMS: versioned manifest and responsive px schema | [eshobe-cms #209](https://github.com/hamidnoshady/eshobe-cms/issues/209) |
| CMS: grouped Payload-native settings UI | [eshobe-cms #210](https://github.com/hamidnoshady/eshobe-cms/issues/210) |
| CMS: device preview workflow | [eshobe-cms #211](https://github.com/hamidnoshady/eshobe-cms/issues/211) |
| CMS: legacy compatibility and cross-theme tests | [eshobe-cms #212](https://github.com/hamidnoshady/eshobe-cms/issues/212) |
| First theme: manifest adoption | [cms-arch3-theme #26](https://github.com/hamidnoshady/cms-arch3-theme/issues/26) |
| First theme: responsive CSS and visual verification | [cms-arch3-theme #27](https://github.com/hamidnoshady/cms-arch3-theme/issues/27) |

## 6. Development sequence

1. **Done (this CMS):** typed manifest extension + parser, validator, resolution and compatibility policy.
2. **Done (this CMS):** reusable Payload-native admin settings renderer with compact categories, precise numeric controls, scoped reset and dirty-state guard.
3. **Done (this CMS):** responsive live sample, saved-build viewport preview, legacy preservation and the regression suite.
4. **Pending (themes):** adopt the supported manifest fields and implement responsive CSS tokens and visual regression tests.
5. Release only when the CMS and theme versions are compatible, and document the minimum supported CMS version.

**Rule for all AI agents and theme developers:** read this document before creating a new theme or adding a new theme setting. Do not add theme-specific admin forms or unsupported manifest keys. If the current CMS contract lacks a desired control, open a CMS contract issue first and preserve the existing runtime API until the shared extension ships.
