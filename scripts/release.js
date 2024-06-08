// from https://github.com/vuejs/vue/blob/main/scripts/release.js
const fs = require("fs");
const path = require("path");

const args = require("minimist")(process.argv.slice(2));
const chalk = require("chalk");
const semver = require("semver");
const { prompt } = require("enquirer");
const execa = require("execa");

const { version: currentVersion, name: pkgName } = require("../package.json");

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

function updatePackage(pkgRoot, version) {
  if (isDryRun) {
    console.log(
      chalk.blue(
        `[dryrun] modify ${pkgRoot}/package.json version to [${version}]`
      )
    );
  } else {
    const pkgPath = path.resolve(pkgRoot, "package.json");
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
    pkg.version = version;
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  }
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
        // "--dry-run",
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

async function main() {
  let targetVersion = args._[0];

  // 1. 确定版本
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

  // 2. 测试
  step("\nRunning tests...");
  if (!skipTests && !isDryRun) {
    await run("npm", ["run", "test"]);
  } else {
    console.log(`(test skipped)`);
  }

  // 3. 更新package.json中的version字段
  step("\nUpdating package versions...");
  packages.forEach((p) => updatePackage(p.dir, targetVersion));

  // 4. 构建
  step("\nBuilding all packages...");
  if (!skipBuild) {
    await runIfNotDry("npm", ["run", "build"]);
    await runIfNotDry("npm", ["run", "build:types"]);
  } else {
    console.log(`(build skipped)`);
  }

  // 5. 改动日志
  step("\nGenerating changelog...");
  await runIfNotDry(`npm`, ["run", "changelog"]);

  // 6. 更新 pnpm-lock.yaml
  // step("\nUpdating lockfile...");
  // await runIfNotDry(`npm`, ["install", "--prefer-offline"]);

  // 7. commit
  const { stdout } = await run("git", ["diff"], { stdio: "pipe" });
  if (stdout) {
    step("\nCommitting changes...");
    await runIfNotDry("git", ["add", "-A"]);
    await runIfNotDry("git", ["commit", "-m", `release: v${targetVersion}`]);
  } else {
    console.log("No changes to commit.");
  }

  // 8. 发布 package
  step("\nPublishing packages...");
  for (const pkg of packages) {
    await publishPackage(pkg, targetVersion, runIfNotDry);
  }

  // 9. 推送 release 和 tag
  step("\nPushing to GitHub...");
  await runIfNotDry("git", ["tag", `v${targetVersion}`]);
  await runIfNotDry("git", ["push", "origin", `refs/tags/v${targetVersion}`]); // git push 不会把tag推到远程
  await runIfNotDry("git", ["push"]);

  if (isDryRun) {
    console.log(`\nDry run finished - run git diff to see package changes.`);
  }
  console.log();
}

main();
