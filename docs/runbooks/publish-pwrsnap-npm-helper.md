# Publish the `pwrsnap` npm helper

## Owner and approval gate

- Publication owner: **@huntharo**, acting for **PwrDrvr LLC**.
- GitHub gate: the `npm-publishing` environment must require approval from
  @huntharo and restrict deployments to `main` before the first run.
- npm gate: configure npm Trusted Publishing for repository
  `pwrdrvr/PwrSnap`, workflow `publish-npm-helper.yml`, environment
  `npm-publishing`. The workflow uses short-lived OIDC credentials and does not
  accept a long-lived npm token.

The workflow also rejects any dispatch whose actor is not @huntharo, whose ref
is not `main`, whose requested version differs from
`packages/pwrsnap/package.json`, whose confirmation text is not exact, or whose
version already exists on npm.

## Publish `0.0.1` after #500 merges

Merging #500 does **not** update npm. After it is on `main` and CI is green,
the publication owner runs:

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
