# Publish the `pwrsnap` npm helper

## Owner and approval gate

- Publication owner: **@huntharo**, acting for **PwrDrvr LLC**.
- GitHub gate: **provisioned 2026-08-23**. The `npm-publishing` environment
  requires approval from @huntharo and its custom deployment branch policy
  allows only `main`.
- npm gate: **not yet configured or verified**. Configure npm Trusted
  Publishing for repository
  `pwrdrvr/PwrSnap`, workflow `publish-npm-helper.yml`, environment
  `npm-publishing`. The workflow uses short-lived OIDC credentials and does not
  accept a long-lived npm token.

Do not dispatch the publication workflow until the npm Trusted Publisher is
configured in the existing `pwrsnap` package settings and the publication owner
has verified that its repository, workflow filename, and environment fields
exactly match the values above. GitHub environment setup does not configure npm.

The GitHub gate can be audited without dispatching anything:

```bash
gh api repos/pwrdrvr/PwrSnap/environments/npm-publishing \
  --jq '{name, protection_rules, deployment_branch_policy}'
gh api repos/pwrdrvr/PwrSnap/environments/npm-publishing/deployment-branch-policies \
  --jq '.branch_policies[] | {name, type}'
```

The workflow also rejects any dispatch whose actor is not @huntharo, whose ref
is not `main`, whose requested version differs from
`packages/pwrsnap/package.json`, whose confirmation text is not exact, or whose
version already exists on npm.

## Release-order gate: stable PwrSnap 1.1 comes first

The helper sends users to GitHub's `/releases/latest` URL. At the time this gate
was added, that URL resolved to `v1.0.3`. Publishing the helper in that state
would create a new 1.0 download funnel, so **do not publish npm `0.0.1` merely
because #500 has merged**.

The workflow queries GitHub's latest-release API immediately before testing or
publishing. It proceeds only when the response is a non-draft, non-prerelease
tag matching `v1.1.x`. A dispatch while `v1.0.3`, a 1.1 prerelease, or any other
version is latest fails before `npm publish`.

The publication owner should independently verify the release order:

```bash
gh api repos/pwrdrvr/PwrSnap/releases/latest \
  --jq '{tag_name, draft, prerelease, html_url}'
```

The expected result is a stable `v1.1.x` tag with both booleans set to `false`.

## Publish `0.0.1` after #500 merges and stable 1.1 is latest

Merging #500 does **not** update npm. Only after #500 is on `main`, CI is green,
the npm Trusted Publisher is configured and verified, and stable PwrSnap 1.1 is
GitHub `latest`, the publication owner runs:

```bash
gh workflow run publish-npm-helper.yml \
  --ref main \
  -f version=0.0.1 \
  -f 'confirmation=publish pwrsnap@0.0.1'
```

Approve the `npm-publishing` environment deployment when GitHub prompts. Do
not publish from a pull-request branch or run `npm publish` locally.

## Public verification

The publish job does not stop at `npm publish`. It waits for registry
propagation, installs `pwrsnap@0.0.1` into a fresh temporary directory, and
checks all three public behaviors:

- no arguments print the official PwrSnap release URL;
- `--version` identifies `0.0.1` as the npm helper version, not the desktop app;
- `install` is rejected on stderr with exit code 2.

The job fails if any probe disagrees. Its final log line must be:

```text
Verified public pwrsnap@0.0.1 from the npm registry.
```

For a manual second check after the workflow succeeds:

```bash
npm view pwrsnap@0.0.1 version
npx --yes pwrsnap@0.0.1
npx --yes pwrsnap@0.0.1 --version
npx --yes pwrsnap@0.0.1 install; test $? -eq 2
```
