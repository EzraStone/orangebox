# Releasing orangebox

Releases are tag-driven. CI tests a packed install on Windows, macOS, and Linux before publishing the exact same tarball to npm and attaching it to a GitHub release with a build-provenance attestation.

## One-time repository setup

1. Create an npm automation or granular access token allowed to publish `orangebox-ai`.
2. In GitHub, open **Settings → Secrets and variables → Actions → New repository secret**.
3. Name the secret `NPM_TOKEN` and paste the npm token.
4. Keep GitHub Actions permissions enabled for the repository. The release workflow requests only contents, identity-token, and artifact-attestation writes.

## Publish a version

1. Update `package.json`, `package-lock.json`, and `CHANGELOG.md` in a normal commit.
2. Confirm `npm test` and `npm run smoke:install` pass.
3. Create a signed annotated tag. With a configured signing key:

   ```bash
   git tag -s v1.1.0 -m "orangebox v1.1.0"
   git tag -v v1.1.0
   git push origin main v1.1.0
   ```

4. Watch the **Release** workflow. It refuses a tag that does not match the package version, verifies all three operating systems, publishes npm with provenance, attests the tarball, and creates the GitHub release.

Never move or reuse a published version tag. If a workflow fails after npm accepts a version, fix the workflow and create the next patch version because npm versions are immutable.
