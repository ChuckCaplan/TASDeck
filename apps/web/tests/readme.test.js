const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const README_PATH = path.resolve("README.md");

// Adding a row to the Verified TAS Runs table means updating the count in the
// badge and in the sentence above the table; this catches a missed update.
test("README verified-run count matches the Verified TAS Runs table", () => {
  const readme = readFileSync(README_PATH, "utf8");
  const section = readme.split("\n## Verified TAS Runs\n")[1]?.split("\n## ")[0];
  assert.ok(section, "README has a Verified TAS Runs section");

  const rows = section
    .split("\n")
    .filter((line) => line.startsWith("|") && !line.startsWith("| Game and run") && !line.startsWith("| ---"));
  assert.ok(rows.length > 0, "Verified TAS Runs table has rows");

  const sentence = /The following \*\*(\d+)\*\* runs have completed successfully/.exec(section);
  assert.ok(sentence, "Verified TAS Runs section states the run count");
  assert.equal(Number(sentence[1]), rows.length, "run count in the sentence above the table");

  const badge = /img\.shields\.io\/badge\/verified%20runs-(\d+)-/.exec(readme);
  assert.ok(badge, "README has a verified runs badge");
  assert.equal(Number(badge[1]), rows.length, "run count in the verified runs badge");
});
