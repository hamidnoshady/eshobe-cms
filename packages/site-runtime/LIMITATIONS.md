# Intentional limitations (`@eshobe/site-runtime`)

Documented shortcuts marked `ponytail:` in source. They are acceptable for v1 unless a customer need forces a change.

## Time zone (`format.ts`)

All calendar dates format in `Asia/Tehran`. The CMS default locale is Persian-first and every hosted customer today is Iran-based. A per-site `timezone` field on `sites` is the planned upgrade when a tenant outside Iran needs local midnights.

## Neutral palette (`theme.ts`)

`themeCss` applies the site's `background` and `foreground` on the light palette only. Card, muted, and border tokens are **not** re-derived from a non-default background; external themes should supply their own neutral ramp when `background` is not a light surface.
