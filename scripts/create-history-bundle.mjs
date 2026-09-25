/**
 * Write the complete Git history to a single verified file.
 *
 * This product keeps every piece of data on the machine it runs on, and its
 * repository has no remote, so a rollback point has to be something a person
 * can copy to another drive by hand. A bundle is that: one file holding every
 * commit, branch and tag, restorable with `git clone <file> <folder>`.
 *
 * It covers the Git repository and nothing else. The Local Data Folder, the
 * service configuration, the Node and pnpm runtimes, the dependency store and
 * the operating system are all outside it, so this is a source rollback point
 * and not a disaster recovery of the running product.
 *
 * Rules the file has to earn its name by:
 *  - a dirty working tree fails the run, because a bundle that silently omits
 *    uncommitted work is worse than no bundle at all;
 *  - the name carries the time and a unique suffix, so a second run on the
 *    same day cannot overwrite a good backup;
 *  - it is built into a temporary file beside its destination and verified
 *    there, and its checksum is published before it is, so a published bundle
 *    always has a checksum to check it against;
 *  - an interrupted or failed run leaves every existing bundle untouched.
 */
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

// Resolved from this file, never from the caller's cwd. FORMDIGITAL_BUNDLE_REPO
// exists so the tests can exercise this against a throwaway repository instead
// of the real one.
const projectRoot =
  process.env.FORMDIGITAL_BUNDLE_REPO ||
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// stderr is captured rather than inherited: `git bundle verify` reports the
// file it checked by absolute path, which would otherwise reach the console
// even though nothing this script prints does.
const git = (...args) =>
  execFileSync("git", args, {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

function fail(message) {
  console.error(`[bundle] ${message}`);
  process.exit(1);
}

/** Hashed in chunks: the bundle grows with the history and is never loaded whole. */
async function sha256OfFile(file) {
  const hash = crypto.createHash("sha256");
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest("hex");
}

const dirty = git("status", "--porcelain").trim();
if (dirty)
  fail(
    `refusing to write a bundle while ${dirty.split("\n").length} change(s) are uncommitted. Commit or stash them first.`,
  );

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const unique = crypto.randomUUID().slice(0, 8);
const directory = path.dirname(projectRoot);
const name = `${path.basename(projectRoot)}-${stamp}-${unique}.bundle`;
const target = path.join(directory, name);
const checksumTarget = `${target}.sha256`;
const buildingBundle = path.join(directory, `.${name}.building`);
const buildingChecksum = `${buildingBundle}.sha256`;

if (fs.existsSync(target) || fs.existsSync(checksumTarget))
  fail("a bundle with this name already exists.");

const discard = file => {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // Only files this run created are ever removed here, so a failure to
    // clean up still leaves every existing bundle exactly as it was.
  }
};

let checksumPublished = false;
let bundlePublished = false;
try {
  git("bundle", "create", buildingBundle, "--all");
  // A bundle nobody has verified is not a backup. Verify the temporary file,
  // so a failure here never reaches the published name.
  if (!/complete history/.test(git("bundle", "verify", buildingBundle)))
    throw new Error("did not verify as a complete history");
  fs.writeFileSync(
    buildingChecksum,
    `${await sha256OfFile(buildingBundle)}  ${name}\n`,
  );
  // The checksum is published first. If anything fails between the two
  // renames the checksum is removed again, so the published name is never a
  // bundle that nothing can check.
  // Measured before publishing: nothing that can fail may run between the two
  // renames, or a failure there would leave a published bundle behind while
  // the recovery below removes only its checksum.
  const { size } = fs.statSync(buildingBundle);
  fs.renameSync(buildingChecksum, checksumTarget);
  checksumPublished = true;
  fs.renameSync(buildingBundle, target);
  bundlePublished = true;

  console.log(`[bundle] ${name}`);
  console.log(`[bundle] ${(size / 1048576).toFixed(1)} MiB, verified complete.`);
  console.log(`[bundle] written beside the project folder, with ${name}.sha256`);
  console.log(`[bundle] restore with: git clone "../${name}" <new-folder>`);
  console.log(
    "[bundle] source history only. The Local Data Folder has its own Portable Backup.",
  );
} catch {
  // Fixed and value-free: the underlying error can carry absolute paths.
  discard(buildingBundle);
  discard(buildingChecksum);
  // A published pair is complete and stays. Only a checksum whose bundle never
  // made it is withdrawn, so there is never a bundle without a checksum.
  if (checksumPublished && !bundlePublished) discard(checksumTarget);
  fail("could not publish a verified bundle; no existing bundle was changed.");
}
