# AgentCorp Maintainer Release Guide

This is the maintainer runbook for publishing `agentcorp-broker` to GitHub and
npm. Publishing is intentionally a human-owned action. CI and agents may verify
a release, but they must not create a public repository, push tags, or publish
the package without explicit maintainer authorization.

AgentCorp is currently an alpha developer preview. A GitHub repository is the
source project; npm distributes the installable package built from it. A GitHub
release and an npm release normally point to the same Git tag and version.

## 1. One-time account and repository setup

1. Create a public GitHub repository without adding a README, license, or
   `.gitignore`; those files already exist locally.
2. Decide whether it belongs to your personal account or an organization.
3. Replace every placeholder project URL in `package.json` and `SECURITY.md`
   with that repository's exact URL.
4. Add the remote and use the conventional `main` branch:

   ```sh
   git remote add origin https://github.com/<owner>/AgentCorp.git
   git branch -M main
   git push -u origin main
   ```

5. Enable GitHub branch protection after the first push: require the CI checks
   and prevent accidental force pushes to `main`.
6. Create an npm account, verify its email address, and enable two-factor
   authentication for publishing and account changes.
7. Log in locally and confirm the account:

   ```sh
   npm login
   npm whoami
   ```

GitHub's official instructions for an existing local repository are
[here](https://docs.github.com/en/migrations/importing-source-code/using-the-command-line-to-import-source-code/adding-locally-hosted-code-to-github).

## 2. Choose and verify the npm package name

The manifest currently uses the unscoped name `agentcorp-broker`. Check the
registry immediately before publication:

```sh
npm view agentcorp-broker name version dist-tags --json
```

An npm `E404` means no package is currently returned for that name, but it does
not reserve the name. If the name is unavailable or you want ownership tied to
your npm account or organization, use a scope such as
`@<npm-account>/agentcorp` and update all install examples. A scoped public
package is published with `--access public`.

Do not rename the package after users depend on it unless you are prepared to
publish a migration release. npm package scope guidance is
[here](https://docs.npmjs.com/misc/scope/).

## 3. Automated release gates

Run these commands from a clean release branch:

```sh
npm ci
npm run check
npm run build
npm test
node dist/cli.js validate --config org.toml
node dist/cli.js validate --config examples/org.toml
npm audit --omit=dev
npm pack --dry-run --ignore-scripts
node dist/cli.js doctor --config org.toml
git status --short
```

On Windows PowerShell, use `npm.cmd` if script execution policy blocks
`npm.ps1`. The last command must print nothing. CI repeats the build and test
gates on Ubuntu, Windows, and macOS with supported Node versions.

Inspect the dry-run package listing. It should contain compiled `dist/` files,
the public documentation, examples, license, changelog, security policy, and
contribution guide. It must not contain `.agentcorp/`, `coord/`, `scratch/`,
source tests, credentials, databases, logs, internal design notes, or binary
documentation images.

For the strongest install check, the test suite packs the project, installs it
into a temporary directory outside the checkout, and runs the CLI there.

## 4. Prepare the release commit

Use [Semantic Versioning](https://docs.npmjs.com/about-semantic-versioning/).
During the preview, versions look like `0.1.0-alpha.1`,
`0.1.0-alpha.2`, and then `0.1.0-beta.1`. Once the API is stable, use regular
major, minor, and patch versions.

1. Choose a version that has never been published. npm does not allow the same
   package name and version to be reused, even after unpublishing.
2. Update `package.json` and `package-lock.json` together:

   ```sh
   npm version 0.1.0-alpha.1 --no-git-tag-version
   ```

3. Change the matching changelog heading from `Unreleased` to the publication
   date and add a new `Unreleased` section for future work.
4. Run every release gate again.
5. Commit the exact candidate:

   ```sh
   git add --all
   git commit -m "release: prepare v0.1.0-alpha.1"
   ```

## 5. Create and push the tag

Create a signed tag if a signing identity is configured:

```sh
git tag -s v0.1.0-alpha.1 -m "Release v0.1.0-alpha.1"
```

Otherwise use an annotated, non-cryptographic tag:

```sh
git tag -a v0.1.0-alpha.1 -m "Release v0.1.0-alpha.1"
```

Push the release commit and that exact tag:

```sh
git push origin main
git push origin v0.1.0-alpha.1
```

Avoid `--tags`; pushing only the intended tag reduces accidental publication
of local tags.

## 6. Publish the npm preview

First inspect the final tarball without running lifecycle scripts:

```sh
npm pack --dry-run --ignore-scripts
```

Publish an alpha under the `alpha` distribution tag:

```sh
npm publish --access public --tag alpha
```

The tag matters. Without `--tag alpha`, npm assigns the release to `latest`,
which makes ordinary installs select an unstable preview. npm's publish and
distribution-tag behavior is documented in the
[publish command](https://docs.npmjs.com/cli/commands/npm-publish/) and
[dist-tag guide](https://docs.npmjs.com/adding-dist-tags-to-packages/).

Complete the one-time-password prompt yourself. Never place an npm password,
token, recovery code, or `.agentcorp/credentials.json` in the repository or an
agent message.

For later automated releases, prefer npm
[trusted publishing](https://docs.npmjs.com/trusted-publishers/) from a tightly
protected GitHub Actions environment. It uses short-lived OIDC credentials
instead of a long-lived npm token and can add provenance for a public package
from a public repository. Follow npm's current Node/npm version requirements,
configure the exact repository and workflow filename in npm, and keep the
release environment protected. Do not claim provenance for a local 2FA publish.

## 7. Verify before announcing

Read the registry metadata:

```sh
npm view agentcorp-broker@0.1.0-alpha.1 name version dist-tags repository --json
```

Then install into a new temporary directory or clean machine:

```sh
npm install --global agentcorp-broker@alpha
agentcorp --version
agentcorp --help
```

Initialize a disposable project and verify the actual first-run path:

```sh
mkdir agentcorp-release-check
cd agentcorp-release-check
agentcorp init
agentcorp validate
agentcorp start --daemon
agentcorp doctor
agentcorp stop
```

Finally, create a GitHub release for `v0.1.0-alpha.1`, copy the matching
changelog entry into the notes, and mark it as a **pre-release**. GitHub releases
are based on Git tags; see GitHub's
[release documentation](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases).

Announce the package only after both the npm installation and GitHub release
are visible.

## 8. Recovery rules

- If publication fails before npm accepts it, fix the cause and retry the same
  version only after confirming it is absent with `npm view`.
- If npm accepted a broken release, do not overwrite it. Fix the code, increment
  the prerelease number, rerun all gates, and publish the new version.
- If the wrong dist-tag was used, correct the tag with npm dist-tag commands;
  do not republish identical contents under the same version.
- If credentials may have leaked, revoke or rotate them before any other work.
- Never rewrite a public release tag. Add a new version and tag so users can
  reproduce what was published.

## 9. Release safety invariants

- Policy evaluation and errors remain fail closed.
- Artifact access checks are enforced by the authenticated broker role.
- Runtime credentials, databases, logs, and audit exports are never packaged.
- `package.json`, the Git tag, the changelog, GitHub release, and npm registry
  all report the same version.
- Alpha limitations are stated plainly: local trusted-user deployment, no shell
  sandbox, no independent security audit, and no automatic wake-up of idle IDE
  agents.
