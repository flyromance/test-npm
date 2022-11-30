const args = require("minimist")(process.argv.slice(2));
const fs = require("fs");
const path = require("path");
const chalk = require("chalk");
const semver = require("semver");
const { prompt } = require("enquirer");
const execa = require("execa");

const { version: currentVersion, name: pkgName } = require("../package.json");

function exit() {
  process.exit(0);
}

// console.log(semver.prerelease("v1.0.0-alpha.1")); // 有pre配置 ['alpha', 1]
// console.log(semver.prerelease("v1.0.0")); // 没有pre配置 null

// console.log(semver.coerce('v1.0.0-alpha.1'))
// console.log(semver.clean('v1.0.0-alpha.1'))
// console.log(semver.parse('v1.0.0-alpha.1'))
// console.log(semver.compare('3.0.0', '3.0.0')) 0相等 -1表示小于 1大于
// console.log(semver.satisfies("3.0.0", "> 3.0.0 || 2.0.0"));

// 没有pre，对应的 major/minor/patch +1
// 有pre，对应的 major/minor/patch 不变，去掉pre
console.log(semver.inc("1.0.0", "major", "alpha"));
console.log(semver.inc("1.0.0-alpha.1", "major", "alpha"));
console.log(semver.inc("1.0.0-alpha.1", "minor", "alpha"));

// 对应的 major/minor/patch +1，去掉原有的pre，添加新的pre，xxx.0
console.log(semver.inc("1.0.0", "premajor", "alpha"));
console.log(semver.inc("1.0.0-alpha.1", "preminor", "alpha"));
console.log(semver.inc("1.0.0-alpha.1", "prepatch", "beta"));

// 没有pre，major/minor 不变，patch + 1，添加新pre， xxx.0
// 有pre，major/minor/patch 不变，当前pre一样则数字+1，否则改为第三个参数.0
console.log(semver.inc("1.0.0", "prerelease", "alpha")); // 1.0.1-alpha.0
console.log(semver.inc("1.0.0-alpha.1", "prerelease", "alpha")); // 1.0.0-alpha.2
console.log(semver.inc("1.0.0-alpha.1", "prerelease", "beta")); // 1.0.0-beta.0

// exit();

// alpha beta rc
const preId =
  args.preid ||
  (semver.prerelease(currentVersion) && semver.prerelease(currentVersion)[0]);
const isDryRun = args.dry;
const skipTests = args.skipTests;
const skipBuild = args.skipBuild;
// const packages = fs
//   .readdirSync(path.resolve(__dirname, "../packages"))
//   .filter((p) => !p.endsWith(".ts") && !p.startsWith("."))
//   .concat("vue");

const packages = [
  {
    name: pkgName,
    dir: path.join(__dirname, "../"),
  },
];

const versionIncrements = [
  "patch",
  "minor",
  "major",
  ...(preId ? ["prepatch", "preminor", "premajor", "prerelease"] : []),
];

const inc = (i) => semver.inc(currentVersion, i, preId);
const run = (bin, args, opts = {}) =>
  execa(bin, args, { stdio: "inherit", ...opts });
const dryRun = (bin, args, opts = {}) =>
  console.log(chalk.blue(`[dryrun] ${bin} ${args.join(" ")}`), opts);
const runIfNotDry = isDryRun ? dryRun : run;
const step = (msg) => console.log(chalk.cyan(msg));

async function main() {
  let targetVersion = args._[0];

  if (!targetVersion) {
    // no explicit version, offer suggestions
    const { release } = await prompt({
      type: "select",
      name: "release",
      message: "Select release type",
      choices: versionIncrements
        .map((i) => `${i} (${inc(i)})`)
        .concat(["custom"]),
    });

    if (release === "custom") {
      targetVersion = (
        await prompt({
          type: "input",
          name: "version",
          message: "Input custom version",
          initial: currentVersion,
        })
      ).version;
    } else {
      targetVersion = release.match(/\((.*)\)/)[1];
    }
  }

  if (!semver.valid(targetVersion)) {
    throw new Error(`invalid target version: ${targetVersion}`);
  }

  const { yes } = await prompt({
    type: "confirm",
    name: "yes",
    message: `Releasing v${targetVersion}. Confirm?`,
  });

  if (!yes) {
    return;
  }

  // run tests before release
  step("\nRunning tests...");
  if (!skipTests && !isDryRun) {
    await run("npm", ["run", "test"]);
  } else {
    console.log(`(skipped)`);
  }

  // update all package versions and inter-dependencies
  step("\nUpdating package versions...");
  packages.forEach((p) => updatePackage(p.dir, targetVersion));

  // build all packages with types
  step("\nBuilding all packages...");
  if (!skipBuild && !isDryRun) {
    await run("npm", ["run", "build"]);
    if (skipTests) {
      await run("npm", ["run", "build:types"]);
    }
  } else {
    console.log(`(skipped)`);
  }

  // generate changelog
  step("\nGenerating changelog...");
  await run(`npm`, ["run", "changelog"]);

  // update pnpm-lock.yaml
  step("\nUpdating lockfile...");
  // await run(`npm`, ["install", "--prefer-offline"]);

  const { stdout } = await run("git", ["diff"], { stdio: "pipe" });
  if (stdout) {
    step("\nCommitting changes...");
    await runIfNotDry("git", ["add", "-A"]);
    await runIfNotDry("git", ["commit", "-m", `release: v${targetVersion}`]);
  } else {
    console.log("No changes to commit.");
  }

  // publish packages
  step("\nPublishing packages...");
  for (const pkg of packages) {
    await publishPackage(pkg, targetVersion, runIfNotDry);
  }

  // push to GitHub
  step("\nPushing to GitHub...");
  await runIfNotDry("git", ["tag", `v${targetVersion}`]);
  await runIfNotDry("git", ["push", "origin", `refs/tags/v${targetVersion}`]);
  await runIfNotDry("git", ["push"]);

  if (isDryRun) {
    console.log(`\nDry run finished - run git diff to see package changes.`);
  }
  console.log();
}

function updatePackage(pkgRoot, version) {
  const pkgPath = path.resolve(pkgRoot, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
  pkg.version = version;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
}

async function publishPackage(conf, version, runIfNotDry) {
  const pkgRoot = conf.dir;
  const pkgPath = path.resolve(pkgRoot, "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
  const publishedName = pkg.name;
  if (pkg.private) {
    return;
  }

  let releaseTag = null;
  if (args.tag) {
    releaseTag = args.tag;
  } else if (version.includes("alpha")) {
    releaseTag = "alpha";
  } else if (version.includes("beta")) {
    releaseTag = "beta";
  } else if (version.includes("rc")) {
    releaseTag = "rc";
  }

  step(`Publishing ${publishedName}...`);
  try {
    await runIfNotDry(
      "npm",
      [
        "publish",
        ...(releaseTag ? ["--tag", releaseTag] : []),
        "--access",
        "public",
        "--dry-run",
      ],
      {
        cwd: pkgRoot,
        stdio: "pipe",
      }
    );
    console.log(
      chalk.green(`Successfully published ${publishedName}@${version}`)
    );
  } catch (e) {
    if (e.stderr.match(/previously published/)) {
      console.log(chalk.red(`Skipping already published: ${publishedName}`));
    } else {
      throw e;
    }
  }
}

main();
