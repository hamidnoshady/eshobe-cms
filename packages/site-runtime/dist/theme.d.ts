export type Theme = {
    primary?: string | null;
    accent?: string | null;
    background?: string | null;
    foreground?: string | null;
    radius?: 'lg' | 'md' | 'sm' | 'none' | null;
    lineHeight?: number | null;
};
/**
 * Per-site design tokens as a `<style>` body.
 *
 * Tailwind v4's `@theme inline` block in `globals.css` maps every utility token to a
 * raw variable (`--color-primary: var(--primary)`), so per-site theming is just
 * re-declaring those raw variables lower down the cascade. No per-tenant CSS build,
 * no rebuild when an editor saves.
 */
/**
 * `#rgb` or `#rrggbb`, and nothing else. These values are interpolated into a
 * `<style>` tag, so a stray `}` would let a site's editor rewrite the whole page's
 * CSS — an unvalidated value is dropped rather than emitted.
 */
export declare const isHexColor: (value: unknown) => value is string;
export declare const themeCss: (theme: null | Theme) => string;
//# sourceMappingURL=theme.d.ts.map