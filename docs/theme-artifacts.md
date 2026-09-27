# Immutable theme images

Eshobe supports two independent deployment strategies on the existing deployment lifecycle:

- `coolify_build`: Coolify clones GitHub and builds the manifest's Nixpacks, Dockerfile, static, or Compose source.
- `registry_image`: CI builds once, pushes GHCR, registers the resulting digest, and Coolify pulls that exact image.

Repository visibility and image visibility are independent. A single deploy target can enable public Git, GitHub App, deploy-key fallback, anonymous registry pulls, and a private GHCR credential reference simultaneously.

## Recommended repository workflow

A theme repository should run: checkout → validate `eshobe.theme.json` → install → lint → typecheck → tests → build → container smoke test → Docker Buildx → push GHCR → inspect pushed digest → register it with Eshobe. Tags such as the commit SHA, semantic version, branch, and `latest` are useful labels only. Eshobe deploys `ghcr.io/owner/image@sha256:…`; it never uses a mutable tag as production identity.

Register a successful image with:

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

## Placements and identity

A deploy target has a default server and separate preview/production project, environment, and optional server override. Both lanes may use the same project with different environments, different projects, or different servers. An omitted lane server inherits the default.

Bindings copy the resolved server, project, and environment when first created. Later edits to target defaults affect only new bindings. Application identity remains `site × package × lane`; it never includes domain, commit, tag, or digest.

## Promotion, redeploy, and rollback

A registry preview and production can both be queued with the same `artifact` ID. No build occurs between them. `site-deployments` stores the artifact, commit, repository, display tag, and immutable digest.

- Redeploy without `upgrade: true` reuses the current artifact.
- Upgrade selects the ready artifact for the package's pinned commit, otherwise its synced commit.
- Rollback selects the old deployment's artifact and digest; it does not rebuild.
- A newly detected GitHub commit is not deployable until a ready artifact for that exact commit exists.
- GitHub push only syncs metadata. It never deploys production.

All strategies share binding resolution, runtime environment injection, Coolify deployment polling, health checking, stale-site/domain checks, and promotion. Site API keys and tenant secrets are runtime values and are not baked into reusable images.

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
