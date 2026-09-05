# AgentCorp Release Guide

This guide describes the release process for `agentcorp-broker`. It strictly separates automated pre-release verification gates from maintainer-owned release actions.

---

## 1. Automated Verification Gates

Before preparing or cutting any release candidate, all automated gates must pass cleanly on the release branch:

```sh
# 1. Typecheck TypeScript source
npm run check

# 2. Build production distribution and static console assets
npm run build

# 3. Run full automated test suite (including E2E chaos, bounding, and package smoke tests)
npm test

# 4. Validate default and example configurations
node dist/cli.js validate --config org.toml
node dist/cli.js validate --config examples/org.toml

# 5. Verify zero production dependency vulnerabilities
npm audit --omit=dev

# 6. Verify lean curated npm tarball contents
npm pack --dry-run --ignore-scripts

# 7. Verify operational health via system doctor
node dist/cli.js doctor --config org.toml
```

These checks are also enforced across platforms (Ubuntu, Windows, macOS) in GitHub CI (`.github/workflows/ci.yml`).

---

## 2. Maintainer-Owned Release Actions

Release publication and tagging are strictly manual, maintainer-owned actions. Automated agents and CI pipelines must **never** push tags, create remote repositories, or publish to npm.

### Step 1: Version & Changelog Finalization
1. Ensure the working tree is clean on `master`.
2. Confirm `version` in `package.json` matches the intended release (e.g. `0.1.0-alpha.1`).
3. Verify that `CHANGELOG.md` documents all features, breaking changes, fixes, and schema migrations under the release heading.
4. Replace `Unreleased` in that heading with the actual publication date (`YYYY-MM-DD`) only when cutting the release.

### Step 2: Create Git Tag
Create a signed tag when you have configured a signing identity:
```sh
git tag -s v0.1.0-alpha.1 -m "Release v0.1.0-alpha.1"
```

Otherwise, create an annotated tag and state clearly that it is not cryptographically signed:
```sh
git tag -a v0.1.0-alpha.1 -m "Release v0.1.0-alpha.1"
```

### Step 3: Push Commit & Tags to Official Remote
```sh
git push origin master --tags
```

### Step 4: GitHub Release Creation
1. Navigate to GitHub Releases.
2. Draft a new release associated with `v0.1.0-alpha.1`.
3. Copy the corresponding section from `CHANGELOG.md` into the release notes.
4. Mark as **Pre-release** for alpha/beta versions.

### Step 5: Publish to npm Registry
Publishing requires maintainer npm credentials with two-factor authentication (2FA):

```sh
# For alpha/preview releases:
npm publish --access public --tag alpha

# For stable GA releases:
npm publish --access public
```

Only add `--provenance` when publishing from a supported CI environment with an
OIDC trusted-publisher configuration. A local 2FA publication does not acquire
provenance merely by adding the flag. Confirm the provenance badge and
attestation on npm before claiming that a release has provenance.

### Step 6: Post-Release Registry Verification
Verify the published package in a clean temporary directory:
```sh
npm install -g agentcorp-broker@0.1.0-alpha.1
agentcorp --version
agentcorp doctor
```

---

## 3. Release Safety Invariants

- **Credential Isolation**: Runtime credentials (`.agentcorp/credentials.json`), databases (`.agentcorp/agentcorp.db`), and logs (`.agentcorp/*.log`) must never be packaged or committed.
- **Fail-Closed Gate**: Policy evaluation must fail closed; no release artifact should ever allow unapproved task state transitions or message delivery.
- **Package Bulk Curation**: The npm package must remain lean (under 200 KB packed), containing compiled runtime code, declarations, source maps, console assets, and markdown documentation while excluding bulky binary images or internal specs.
- **Developer Preview Notice**: Clearly communicate security assumptions until an independent audit is completed.
