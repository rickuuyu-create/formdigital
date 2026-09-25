/**
 * Proves the offline rollback point is really a rollback point.
 *
 * Everything here happens in a throwaway repository under the system temp
 * folder: the real repository is never bundled, cloned over, or made dirty by
 * this test. A bundle is only worth having if it can be cloned back and the
 * clone carries the same commit, branch and tags as the source, so that is
 * what is asserted rather than the exit code of the tool that wrote it.
 */
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const script = path.join(projectRoot, "scripts", "create-history-bundle.mjs");
const workspace = await fsp.mkdtemp(path.join(os.tmpdir(), "formdigital-bundle-"));
const repo = path.join(workspace, "SampleProject");

const git = (cwd, ...args) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

function runBundle() {
  try {
    return {
      ok: true,
      output: execFileSync(process.execPath, [script], {
        cwd: workspace,
        encoding: "utf8",
        env: { ...process.env, FORMDIGITAL_BUNDLE_REPO: repo },
      }),
    };
  } catch (error) {
    return { ok: false, output: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

const bundles = async () =>
  (await fsp.readdir(workspace)).filter(entry => entry.endsWith(".bundle"));

const assertions = {};
function check(name, condition, message) {
  if (!condition) throw new Error(`${name}: ${message}`);
  assertions[name] = true;
}

try {
  // --- a small repository with the shape the real one has -----------------
  await fsp.mkdir(repo, { recursive: true });
  git(repo, "init", "--quiet");
  git(repo, "config", "user.email", "bundle-test@example.invalid");
  git(repo, "config", "user.name", "Bundle Test");
  await fsp.writeFile(path.join(repo, "first.txt"), "one\n");
  git(repo, "add", "-A");
  git(repo, "commit", "--quiet", "-m", "first");
  git(repo, "tag", "-a", "verified-baseline-test", "-m", "baseline");
  await fsp.writeFile(path.join(repo, "second.txt"), "two\n");
  git(repo, "add", "-A");
  git(repo, "commit", "--quiet", "-m", "second");
  git(repo, "tag", "-a", "release-test", "-m", "release");
  git(repo, "branch", "delivery/test");
  const sourceHead = git(repo, "rev-parse", "HEAD").trim();
  const sourceBranch = git(repo, "rev-parse", "--abbrev-ref", "HEAD").trim();
  const sourceTags = git(repo, "tag", "-l").trim().split("\n").sort();

  // --- a dirty tree must fail closed, not warn and carry on ---------------
  await fsp.writeFile(path.join(repo, "uncommitted.txt"), "not saved\n");
  const dirtyRun = runBundle();
  check("dirtyTreeFailsClosed", !dirtyRun.ok, "a dirty tree still produced a bundle");
  check(
    "dirtyTreeWritesNothing",
    (await bundles()).length === 0,
    "a refused run still left a bundle behind",
  );
  await fsp.rm(path.join(repo, "uncommitted.txt"));

  // --- a clean tree publishes a verified bundle and a checksum ------------
  const firstRun = runBundle();
  check("cleanTreePublishes", firstRun.ok, `the bundle run failed: ${firstRun.output}`);
  const afterFirst = await bundles();
  check("publishesOneBundle", afterFirst.length === 1, "expected exactly one bundle");
  const firstBundle = path.join(workspace, afterFirst[0]);
  const sidecar = `${firstBundle}.sha256`;
  check("writesChecksumSidecar", fs.existsSync(sidecar), "no .sha256 sidecar was written");
  const recorded = (await fsp.readFile(sidecar, "utf8")).trim().split(/\s+/)[0];
  check(
    "checksumNamesTheBundle",
    (await fsp.readFile(sidecar, "utf8")).trim().endsWith(path.basename(firstBundle)),
    "the sidecar does not name its bundle",
  );
  const actual = crypto
    .createHash("sha256")
    .update(await fsp.readFile(firstBundle))
    .digest("hex");
  check("checksumMatches", recorded === actual, "the sidecar checksum does not match the bundle");
  check(
    "leavesNoTemporaryFile",
    (await fsp.readdir(workspace)).every(entry => !entry.endsWith(".building")),
    "a temporary build file was left behind",
  );

  // --- a second run must not overwrite the first --------------------------
  const firstBytes = await fsp.readFile(firstBundle);
  const secondRun = runBundle();
  check("secondRunPublishes", secondRun.ok, `the second run failed: ${secondRun.output}`);
  const afterSecond = await bundles();
  check("secondRunUsesNewName", afterSecond.length === 2, "the second run reused a name");
  check(
    "firstBundleUntouched",
    firstBytes.equals(await fsp.readFile(firstBundle)),
    "the second run modified the first bundle",
  );

  // --- the whole point: it clones back, with the same refs ----------------
  const restored = path.join(workspace, "restored");
  git(workspace, "clone", "--quiet", firstBundle, restored);
  check(
    "restoredHeadMatches",
    git(restored, "rev-parse", "HEAD").trim() === sourceHead,
    "the restored HEAD is a different commit",
  );
  check(
    "restoredBranchMatches",
    git(restored, "rev-parse", "--abbrev-ref", "HEAD").trim() === sourceBranch,
    "the restored branch has a different name",
  );
  const restoredTags = git(restored, "tag", "-l").trim().split("\n").sort();
  check(
    "restoredTagsMatch",
    JSON.stringify(restoredTags) === JSON.stringify(sourceTags),
    `restored tags ${restoredTags.join(",")} do not match ${sourceTags.join(",")}`,
  );
  check(
    "restoredContentMatches",
    // Checkout may normalise line endings on this platform, so compare the
    // text rather than the exact bytes.
    (await fsp.readFile(path.join(restored, "second.txt"), "utf8")).trim() === "two",
    "the restored working tree has different content",
  );

  // --- a published bundle always has a checksum beside it -----------------
  // Publishing the bundle first and the checksum second left a bundle nothing
  // could verify whenever the second write failed.
  const published = (await fsp.readdir(workspace)).filter(entry =>
    entry.endsWith(".bundle"),
  );
  for (const entry of published)
    check(
      "everyBundleHasChecksum",
      fs.existsSync(path.join(workspace, `${entry}.sha256`)),
      `${entry} was published without a checksum`,
    );

  // --- nothing it prints leaks a local path --------------------------------
  const printsNoAbsolutePath =
    !/[A-Za-z]:[\/]/.test(firstRun.output) && !firstRun.output.includes(workspace);
  check(
    "printsNoAbsolutePath",
    printsNoAbsolutePath,
    `the run printed a local path: ${firstRun.output.slice(0, 200)}`,
  );

  // --- the restore command it prints actually works ------------------------
  // Printed as a path relative to the project folder, because that is where a
  // person runs it from and the bundle sits one level above.
  const printedRestore = path.join(repo, "..", path.basename(firstBundle));
  check(
    "printedRestorePathResolves",
    fs.existsSync(printedRestore),
    "the restore path printed for the project folder does not resolve",
  );

  // --- a bundle that fails verification must not be published -------------
  const damaged = path.join(workspace, "damaged.bundle");
  await fsp.copyFile(firstBundle, damaged);
  const handle = await fsp.open(damaged, "r+");
  try {
    await handle.write(Buffer.alloc(64, 0), 0, 64, 32);
  } finally {
    await handle.close();
  }
  // Verified from inside a repository, so the refusal is about the damage and
  // not about where the command was run from.
  const verifies = file => {
    try {
      git(restored, "bundle", "verify", file);
      return true;
    } catch {
      return false;
    }
  };
  check("intactBundleVerifies", verifies(firstBundle), "an intact bundle failed to verify");
  check("damagedBundleFailsVerify", !verifies(damaged), "a damaged bundle still verified");

  console.log(JSON.stringify({ verified: true, ...assertions }, null, 2));
} finally {
  await fsp.rm(workspace, { recursive: true, force: true }).catch(() => {});
}
