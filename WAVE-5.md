# Wave 5: site provisioning (agency-operated)

Creating a client site is one action, not a checklist. There is no public signup
funnel: an operator (platform admin) fills in one form, and the site goes from
nothing to editable, themed and populated.

## Where the action lives

| Surface | Path | Notes |
|---|---|---|
| Admin view | `/admin/collections/sites/provision` | Reached from the **ساخت سایت جدید** button in the Sites list header. Persian form, admin-native inputs. |
| Endpoint | `POST /api/provision-site` | Platform-admin only (`403` otherwise). Returns the created site, a summary and the invited users. |
| Core function | `src/provisioning/provisionSite.ts` | `provisionSite({ input, payload, req })` — callable from scripts/tests via the Local API. The role check lives here, not only in the endpoint. |

The form asks for exactly what the `sites` doc needs — name, domain, type,
locales, default locale — plus the client's users (email + per-site role). Nothing
else: pages, navigation, footer, theme and translations are the action's job.

## What the action creates

Everything runs in **one database transaction**; a failure mid-flow rolls the
whole site back (verified by a test that forces a write to fail after the pages
exist).

1. The `sites` doc — `status: 'active'`, slug derived from the Persian name
   (falling back to the domain if that slug is taken).
2. A `theme` doc per site type:
   - business — teal `#0f766e` / amber, small radius
   - portfolio — violet `#7c3aed` / sky, large radius, roomier line-height
   - store — rose `#be123c` / teal, medium radius
3. A contact form, then the starter pages — `contact` first, so later pages'
   CTA blocks can reference it; `home` last. Per type:
   - **business**: home (features, testimonial, CTA), about (team), services
     (pricing, FAQ), contact (details + form)
   - **portfolio**: home (features, testimonial, CTA), about (team), services
     (FAQ), contact
   - **store**: home (features, FAQ, CTA), about, products (categories, FAQ),
     contact
   All pages are created **published**, in the site's default locale.
4. A second-locale pass for every other locale the site serves: page content,
   nav labels and form labels are translated by rewriting each localized field
   on the *same* rows (row ids preserved — a translation, not a rewrite), and
   every page gets a slug row per locale so the nav never links to a 404.
5. Header and footer navs referencing the created pages.
6. **Invites**: each user is created (or, if the account already exists,
   assigned) with a per-site role — `owner` can publish, `editor` drafts only.
   New accounts get a random password the operator never sees; the invite is a
   set-password email sent by Payload's forgot-password flow after the commit.

With no email adapter configured, invite emails print to the server console —
fine for local dev; production configures one.

## Site lifecycle

Suspended and archived sites still resolve by host, but serve a **holding page**
on every path — no content, no header/footer/theme, `noindex` — instead of
silently 404ing or erroring. Reactivate by setting `status` back to `active`.
Sites are archived, not deleted; deleting one with assigned users fails (the
users' `tenants` rows reference it), which is deliberate.

## Starter content is seed functions, not a template engine

`src/provisioning/starter-content.ts` holds plain copy tables (fa + en) and
builder functions per site type — no interpolation engine, no template files.
Adding a site type means adding a copy table and a builder; the invariant the
translation pass depends on (both locales build the same block sequence) is
asserted by test.
