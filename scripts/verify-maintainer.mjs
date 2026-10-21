// SPDX-License-Identifier: Apache-2.0
// See LICENSE and PROJECT_IDENTITY.json in the repository root.

import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { delimiter, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = realpathSync(fileURLToPath(new URL("../", import.meta.url)));
const resolvedExecutables = new Map();

const identity = JSON.parse(
  readFileSync(new URL("../PROJECT_IDENTITY.json", import.meta.url), "utf8"),
);
const packageMetadata = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

function run(command, args) {
  const executable = resolveTrustedExecutable(command);
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error)
    throw new Error(`${command} could not be started from ${executable}: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new Error(
      `${command} ${args.join(" ")} failed${detail ? `: ${detail}` : ""}`,
    );
  }
  return result.stdout.trim();
}

function resolveTrustedExecutable(command) {
  const cached = resolvedExecutables.get(command);
  if (cached) return cached;
  const executableName = process.platform === "win32" ? `${command}.exe` : command;
  const known = process.platform === "win32"
    ? command === "git"
      ? [
          join(process.env.ProgramFiles || "C:\\Program Files", "Git", "cmd", executableName),
          join(process.env.ProgramFiles || "C:\\Program Files", "Git", "bin", executableName),
        ]
      : command === "gh"
        ? [join(process.env.ProgramFiles || "C:\\Program Files", "GitHub CLI", executableName)]
        : []
    : [];
  const fromPath = String(process.env.PATH || "")
    .split(delimiter)
    .filter(Boolean)
    .map((directory) => join(directory, executableName));
  for (const candidate of [...known, ...fromPath]) {
    try {
      const absolute = resolve(candidate);
      if (!existsSync(absolute) || !statSync(absolute).isFile()) continue;
      accessSync(absolute, constants.X_OK);
      const canonical = realpathSync(absolute);
      if (isInside(repositoryRoot, canonical) || isInside(realpathSync(process.cwd()), canonical)) continue;
      resolvedExecutables.set(command, canonical);
      return canonical;
    } catch {
      // Try the next trusted absolute candidate.
    }
  }
  throw new Error(`${command} was not found at a trusted absolute path`);
}

function isInside(parent, candidate) {
  const path = relative(parent, candidate);
  return path === "" || (!isAbsolute(path) && !path.startsWith(`..${sep}`) && path !== "..");
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
    "Official publishing identity was not verified. Apache-2.0 development rights are unaffected.\n",
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
      `../${identity.license.mirrorFile}`,
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
  if (packageMetadata.license !== identity.license.spdxReference) {
    fail('package license does not match the recorded open-source license');
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
        openSourceEffectiveDate:
          identity.licenseBoundary.openSourceEffectiveDate,
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
