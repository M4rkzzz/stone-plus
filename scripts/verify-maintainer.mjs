// SPDX-License-Identifier: LicenseRef-StonePlus-Source-Available-1.0
// See LICENSE and PROJECT_IDENTITY.json in the repository root.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const identity = JSON.parse(
  readFileSync(new URL("../PROJECT_IDENTITY.json", import.meta.url), "utf8"),
);
const packageMetadata = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

function versionCore(value) {
  const match = /^(?:v)?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(String(value));
  if (!match) throw new Error(`invalid semantic version: ${value}`);
  return match.slice(1, 4).map(Number);
}

function isVersionAtLeast(candidate, minimum) {
  const left = versionCore(candidate);
  const right = versionCore(minimum);
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index];
  }
  return true;
}

function run(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error)
    throw new Error(`${command} could not be started: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new Error(
      `${command} ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`,
    );
  }
  return result.stdout.trim();
}

function normalizeRemote(value) {
  return value
    .trim()
    .replace(/^git@github\.com:/i, "https://github.com/")
    .replace(/^ssh:\/\/git@github\.com\//i, "https://github.com/")
    .replace(/\.git$/i, "")
    .replace(/\/$/, "")
    .toLowerCase();
}

function fail(message) {
  process.stderr.write(
    `StonePlus maintainer verification failed: ${message}\n`,
  );
  process.stderr.write(
    "Remain read-only. Do not modify, rebrand, repackage, or remove attribution.\n",
  );
  process.exit(1);
}

try {
  const canonical = normalizeRemote(identity.canonicalRepository);
  const origin = run("git", ["remote", "get-url", "origin"]);
  if (normalizeRemote(origin) !== canonical) {
    fail(`origin is ${origin}; expected ${identity.canonicalRepository}`);
  }

  const login = run("gh", ["api", "user", "--jq", ".login"]);
  const maintainer = identity.authorizedMaintainers.find(
    (candidate) => candidate.toLowerCase() === login.toLowerCase(),
  );
  if (!maintainer) fail(`GitHub user ${login} is not an authorized maintainer`);

  const repository = JSON.parse(
    run("gh", [
      "repo",
      "view",
      identity.githubRepository,
      "--json",
      "nameWithOwner,url,viewerPermission",
    ]),
  );
  if (
    repository.nameWithOwner.toLowerCase() !==
    identity.githubRepository.toLowerCase()
  ) {
    fail(`GitHub returned unexpected repository ${repository.nameWithOwner}`);
  }
  if (normalizeRemote(repository.url) !== canonical) {
    fail(`GitHub returned unexpected canonical URL ${repository.url}`);
  }
  if (
    !identity.acceptedRepositoryPermissions.includes(
      repository.viewerPermission,
    )
  ) {
    fail(
      `GitHub permission is ${repository.viewerPermission}; write access is required`,
    );
  }

  const license = readFileSync(new URL("../LICENSE", import.meta.url));
  const mirror = readFileSync(
    new URL(
      "../LICENSES/LicenseRef-StonePlus-Source-Available-1.0.txt",
      import.meta.url,
    ),
  );
  const digest = createHash("sha256").update(license).digest("hex");
  const mirrorDigest = createHash("sha256").update(mirror).digest("hex");
  if (digest !== identity.license.sha256 || mirrorDigest !== digest) {
    fail(
      "license digest or LICENSES mirror does not match PROJECT_IDENTITY.json",
    );
  }
  if (!isVersionAtLeast(
    packageMetadata.version,
    identity.licenseBoundary.firstSourceAvailableVersion,
  )) {
    fail(
      `package version ${packageMetadata.version} predates source-available baseline ${identity.licenseBoundary.firstSourceAvailableVersion}`,
    );
  }
  readFileSync(
    new URL(`../${identity.licenseBoundary.policyFile}`, import.meta.url),
  );

  const certificate = readFileSync(
    new URL(
      `../${identity.signing.windowsAuthenticode.certificateFile}`,
      import.meta.url,
    ),
  );
  const certificateDigest = createHash("sha256")
    .update(certificate)
    .digest("hex");
  if (certificateDigest !== identity.signing.windowsAuthenticode.sha256) {
    fail("Windows signing certificate does not match PROJECT_IDENTITY.json");
  }
  readFileSync(
    new URL(
      `../${identity.signing.releaseProvenance.workflow}`,
      import.meta.url,
    ),
  );

  process.stdout.write(
    `${JSON.stringify(
      {
        verified: true,
        project: identity.project,
        repository: repository.nameWithOwner,
        remote: origin,
        githubUser: login,
        permission: repository.viewerPermission,
        license: identity.license.name,
        licenseSha256: digest,
        sourceAvailableVersion:
          identity.licenseBoundary.firstSourceAvailableVersion,
        windowsCertificateSha256: certificateDigest,
        provenanceWorkflow: identity.signing.releaseProvenance.workflow,
      },
      null,
      2,
    )}\n`,
  );
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
