# Publishing pi-background-tasks

Release checklist for npm and the standalone git repository.

## Preconditions

- npm publish access for `pi-background-tasks`;
- a clean worktree;
- a version bump in `package.json`;
- the exact release commit in the standalone repository.

Do not push, tag, or publish from an automated run unless the operator explicitly requests it.

## Verify

```nu
npm run lint
npm run format:check
npm run test:full
npm run smoke
npm run test:compat
npm run pack:dry-run
npm view pi-background-tasks name version --json
```

Inspect the dry-run file list. It must contain the shell-task extension and must not contain removed Fusion, update-check, attestation, or agent-telemetry modules.

## Publish to npm

```nu
npm login
npm publish --access public
```

After publish, replace `<version>` and run an isolated load smoke:

```nu
let agent_dir = (mktemp -d)
with-env {
  PI_CODING_AGENT_DIR: $agent_dir
  PI_CODING_AGENT_SESSION_DIR: ($agent_dir | path join sessions)
} {
  pi -e $"npm:pi-background-tasks@<version>" --offline --no-tools --no-session -p "/jobs"
}
```

## Publish to git

Pi git installs use the repository root as the package root. Publish this package from its standalone repository, not from a parent monorepo.

```nu
git status --short --branch
git log --oneline -3
git remote -v
git push origin main
git tag $"v<version>"
git push origin $"v<version>"
```

Creating a tag and publishing are irreversible release actions. Confirm the version and commit before either action.

## Package index

The package includes the `pi-package` keyword and `pi.extensions` manifest. After npm publish, verify that the new version appears in the Pi package index.
