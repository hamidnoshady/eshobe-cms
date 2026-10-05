# Immutable theme images

Eshobe supports two independent deployment strategies on the existing deployment lifecycle:

- `coolify_build`: Coolify clones GitHub and builds the manifest's Nixpacks, Dockerfile, static, or Compose source.
- `registry_image`: CI builds once, pushes GHCR, registers the resulting digest, and Coolify pulls that exact image.

Repository visibility and image visibility are independent. A single deploy target can enable public Git, GitHub App, deploy-key fallback, anonymous registry pulls, and a private GHCR credential reference simultaneously.

## Which strategy to use

**Prefer `registry_image` for anything a customer sees.** It is the only strategy where
the bytes that run in production are provably the bytes that passed preview:

| | `registry_image` | `coolify_build` |
|---|---|---|
| Production publish from the console | Ships the live preview's artifact (same digest) | Rebuilds the live preview's commit; same source, not the same bytes |
| «اجرای دوبارهٔ نسخهٔ فعلی» (redeploy) | Reuses the current artifact, no build | Rebuilds the current row's commit |
| Rollback | Pulls the old digest, no build | Rebuilds the old commit |
| Build load on the Coolify server | None (a pull) | A full build per deploy, preview and production separately |

A `coolify_build` deployment resolves a *branch* only when it is asked for one: a
`POST …/deployment` without `ref`, or a redeploy with `upgrade: true`, builds
`effectiveRefFor` (explicit ref › `pinnedCommit` › `defaultRef` HEAD) at the moment the
job runs. The console never does that for production: it sends the preview's commit.
A caller of the API that omits `ref` for production gets HEAD, so pass the commit.

## Recommended repository workflow

A theme repository should run: checkout → validate `eshobe.theme.json` → install → lint → typecheck → tests → build → container smoke test → Docker Buildx → push GHCR → inspect pushed digest → register it with Eshobe. Tags such as the commit SHA, semantic version, branch, and `latest` are useful labels only. Eshobe deploys `ghcr.io/owner/image@sha256:…`; it never uses a mutable tag as production identity.

### What has to exist before the first CI run

On the CMS (`theme-packages` row):

- `deploymentStrategy: registry_image` and `registryProvider: ghcr` (set by manifest sync
  from `deployment` in `eshobe.theme.json`, or by hand in the admin);
- `repository` equal to the CI repository's `owner/name` (compared case-insensitively);
- `registryImageRepository` equal to the image CI pushes, without tag or digest
  (`ghcr.io/owner/image`). Anything else is refused with 422.

On the CMS server: `ESHOBE_THEME_ARTIFACT_SECRET` in the **web** process environment. Without
it the endpoint answers 503 to every callback. Compose files pass an explicit allowlist to
`web`, so the variable has to be listed there too. `docker-compose.srv1.yml` lists it; set its
value in Komodo and redeploy the stack.

In the theme repository, three GitHub Actions secrets:

| Secret | Value |
|---|---|
| `ESHOBE_CMS_URL` | The control-plane origin, e.g. `https://admin.example.com` (`NEXT_PUBLIC_SERVER_URL`). **Not** a customer domain: `/api/platform/*` has no Caddy carve-out, so on a customer domain the callback is a 404. |
| `ESHOBE_THEME_ARTIFACT_SECRET` | The same value as the CMS server's variable. |
| `ESHOBE_THEME_PACKAGE_ID` | The `theme-packages` row's UUID: the id in the admin URL (`/admin/collections/theme-packages/<uuid>`), or `id` in `GET /api/platform/theme-packages`. Not the theme `key`. |

`ESHOBE_CMS_URL` here is a CI secret. It shares a name with the runtime variable the platform
injects into a deployed container, but CI never sees that one.

### Registering the image

A minimal step after `docker/build-push-action` (with `id: push`):

```yaml
- name: Register the image with Eshobe
  env:
    ESHOBE_CMS_URL: ${{ secrets.ESHOBE_CMS_URL }}
    ESHOBE_THEME_ARTIFACT_SECRET: ${{ secrets.ESHOBE_THEME_ARTIFACT_SECRET }}
    ESHOBE_THEME_PACKAGE_ID: ${{ secrets.ESHOBE_THEME_PACKAGE_ID }}
    IMAGE: ghcr.io/owner/theme # must equal the package's registryImageRepository
    DIGEST: ${{ steps.push.outputs.digest }}
  run: |
    body=$(jq -cn \
      --arg repository "$GITHUB_REPOSITORY" --arg ref "$GITHUB_REF_NAME" \
      --arg commit "$GITHUB_SHA" --arg image "$IMAGE" --arg digest "$DIGEST" \
      --arg runId "$GITHUB_RUN_ID" \
      --arg runUrl "$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID" \
      '{repository:$repository, ref:$ref, commit:$commit, registry:"ghcr", image:$image,
        tag:$commit, digest:$digest, workflowRunId:$runId, workflowRunUrl:$runUrl,
        platform:"linux/amd64"}')
    sig="sha256=$(printf '%s' "$body" | openssl dgst -sha256 -hmac "$ESHOBE_THEME_ARTIFACT_SECRET" -hex | sed 's/^.*= //')"
    curl --fail-with-body -sS -X POST \
      -H 'content-type: application/json' -H "x-eshobe-signature-256: $sig" \
      --data-binary "$body" \
      "$ESHOBE_CMS_URL/api/platform/theme-packages/$ESHOBE_THEME_PACKAGE_ID/artifacts"
```

Sign the exact bytes you send. Re-serialising the JSON between signing and sending (a
different key order or whitespace) is a 401.

The request and its rules:

```http
POST /api/platform/theme-packages/<package-uuid>/artifacts
X-Eshobe-Signature-256: sha256=<HMAC-SHA256 of exact raw JSON>
Content-Type: application/json

{
  "repository": "owner/theme",
  "ref": "main",
  "commit": "<40 hex>",
  "registry": "ghcr",
  "image": "ghcr.io/owner/theme",
  "tag": "<commit>",
  "digest": "sha256:<64 hex>",
  "workflowRunId": "123",
  "workflowRunUrl": "https://github.com/owner/theme/actions/runs/123",
  "platform": "linux/amd64",
  "provenanceAvailable": true,
  "sbomAvailable": true
}
```

The signing secret is `ESHOBE_THEME_ARTIFACT_SECRET`. The endpoint is disabled when it is unset. It verifies the signature before parsing, then verifies package, exact source repository, safe ref, commit, exact configured GHCR repository, digest, and workflow URL. Duplicate `(package, commit, digest)` callbacks return the existing row. Client-provided arbitrary images are never accepted.

| Status | Meaning |
|---|---|
| 201 | Registered; `{ ok, artifact, duplicate: false }`. The artifact is `ready` immediately. |
| 200 | Already registered; `{ ok, artifact, duplicate: true }`. Safe to retry a callback. |
| 400 | Empty body, malformed JSON, or the package id is not a UUID. |
| 401 | Signature missing or wrong. |
| 404 | No `theme-packages` row with that id. |
| 422 | The repository, image repository, ref, commit, digest or workflow URL does not match the package or the expected syntax. |
| 503 | `ESHOBE_THEME_ARTIFACT_SECRET` is not set on the CMS server. |

A request that carries an `Authorization` header must also be an operator (platform admin
session or `role: "platform"` key); the HMAC is still required either way.

## Public and private images

Image visibility only changes how Coolify pulls the image. The digest pin, the
registration callback and every check above are the same either way.

- `registryVisibility: public`: Coolify pulls anonymously. The deploy target must allow it
  (`publicRegistryPullEnabled`, on by default).
- `registryVisibility: private`: the target needs `ghcrEnabled` and `ghcrCredentialUuid`, the
  UUID of a registry credential created in Coolify. Eshobe stores only that UUID.

Repository visibility is a separate setting. A private source repository still needs
`GITHUB_THEME_TOKEN` on the CMS for manifest sync, even when the image is public.

The Coolify server must reach `ghcr.io` itself. The CMS accepts only `ghcr.io/…` image
references (`GHCR_IMAGE_PATTERN`), so a pull-through mirror such as srv1's
`ghcr-mirror.liara.ir` cannot be substituted for a theme image.

## Placements and identity

A deploy target has a default server and separate preview/production project, environment, and optional server override. Both lanes may use the same project with different environments, different projects, or different servers. An omitted lane server inherits the default.

Bindings copy the resolved server, project, and environment when first created. Later edits to target defaults affect only new bindings. Application identity remains `site × package × lane`; it never includes domain, commit, tag, or digest.

## Promotion, redeploy, and rollback

A registry preview and production can both be queued with the same `artifact` ID. No build occurs between them. `site-deployments` stores the artifact, commit, repository, display tag, and immutable digest.

- The console's production publish sends the live preview's `artifact`, so production runs the reviewed digest.
- Redeploy without `upgrade: true` reuses the current artifact.
- Upgrade selects the ready artifact for the package's pinned commit, otherwise its synced commit.
- Rollback selects the old deployment's artifact and digest; it does not rebuild.
- A newly detected GitHub commit is not deployable until a ready artifact for that exact commit exists.
- GitHub push only syncs metadata. It never deploys production.

All strategies share binding resolution, runtime environment injection, Coolify deployment polling, health checking, stale-site/domain checks, and promotion. Site API keys and tenant secrets are runtime values and are not baked into reusable images.

### How the digest reaches Coolify

One digest pin, two wire shapes — Coolify's create and update routes validate
`docker_registry_image_name` differently:

- **Create** (`POST /applications/dockerimage`): the full reference
  `ghcr.io/owner/repo@sha256:<64 hex>` in the name field, empty tag. Coolify parses
  and normalizes it itself.
- **Re-point** (`PATCH /applications/{uuid}`): the stored shape — name
  `ghcr.io/owner/repo@sha256` (the bare repository plus Coolify's own `@sha256`
  marker), the bare 64-hex hash in `docker_registry_image_tag`. The full reference
  here is a 422 (`docker_registry_image_name is invalid`), and the PATCH allowlist
  also rejects `project_uuid`, `server_uuid`, `environment_name`,
  `docker_registry_uuid`, `github_app_uuid` and `private_key_uuid` with «This field
  is not allowed» — placement is chosen once at create and never moved by re-point.

Both live in `src/deploy/coolify.ts` (`digestReferenceForCreate`,
`digestPinForPatch`, `repointApplication`), which is the only place allowed to know
these shapes. The container health check Coolify generates is pinned to
`health_check_host: 127.0.0.1` (an IPv4 loopback — its `localhost` default resolves
to `::1` on IPv6-first images and the container is declared unhealthy) with the
manifest's `build.healthCheckPath` and port.

A registry row that reaches the queue without its artifact link is repaired by
`runDeployment` before anything plans from it: the ready artifact for its commit is
resolved and written back (with `ref` and preview hostname if those are missing
too). The refusal «برای این کامیت هنوز تصویر آماده و تأییدشده‌ای وجود ندارد» now
means exactly what it says — no ready artifact exists for that commit.

## Deploy-target examples

Same project, different environments:

```text
Project Eshobe Themes / preview
Project Eshobe Themes / production
```

Different projects:

```text
Eshobe Preview / preview
Eshobe Production / production
```

Different servers use `previewServerUuid` or `productionServerUuid`; null inherits `defaultServerUuid`.

For private repositories prefer GitHub App, then deploy key. For private GHCR, configure the credential in Coolify and store only its UUID in Eshobe. No GitHub or GHCR token belongs on a theme package, artifact, or deployment row.
