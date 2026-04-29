# Release Checklist

Use this checklist before publishing a new npm version.

## Pre-Release

1. Confirm `package.json` has a new version that has not been published before.
2. Run the full local validation set:

```powershell
npm test
npm run benchmark
npm run build
npm run smoke:npx
npm pack --dry-run
```

3. Review `benchmark/results/latest.md` and update docs if measured headline numbers changed.
4. Confirm `README.md`, `docs/quickstart.md`, and `docs/benchmarks.md` describe the release accurately.

## GitHub

1. Commit the release changes.
2. Push to `master`.
3. Confirm GitHub Actions CI passes on Windows, Ubuntu, and macOS.
4. Create a Git tag for the version, matching `package.json`, for example:

```powershell
git tag v0.4.2
git push origin v0.4.2
```

5. Create a GitHub release with concise notes:
   - user-facing changes
   - benchmark changes
   - migration or compatibility notes
   - known limitations

## npm

1. Publish:

```powershell
npm publish --access public
```

2. Verify the published package:

```powershell
npm view codex-mcp-memory-server version
npx -y codex-mcp-memory-server
```

For the runtime verification, start the server only long enough to confirm it reaches `MCP Memory Server running on stdio`, then stop it.

3. Verify setup helper:

```powershell
npx -y -p codex-mcp-memory-server setup-codex-mcp-memory --project-path . --project-id post-publish-smoke --dry-run
```

## Post-Release

1. Check the GitHub release, npm package page, and README rendering.
2. Record any post-publish issue as a GitHub issue or a new TODO item.
3. If a release problem is found, publish a new patch version instead of republishing an existing version.
