"use strict";

// Which console starts a check tries, and how the results read as a verdict. Pure functions; the
// CLI runs the jobs.

// Same ending as the reference: every record was served and the screens after the last record match.
const SAME_ENDING = 0.9;
// NTSC CPU cycles in a frame; an EverDrive launch resets at a random one of them.
const CPU_CYCLES_PER_FRAME = 29781;

// Small deterministic generator so a check's EverDrive launches repeat run to run.
function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Each variant is { name, group, job } where job holds the fields that differ from the base run.
function buildVariants(options = {}) {
  const {
    launches = 8,
    randomRam = 2,
    powerOn = false,
    alignment = true,
    overreads = [],
    startDelay = 0,
    seed = 1,
  } = options;
  const variants = [{ name: "power-on", group: "base", job: {} }];
  const next = random(seed);
  for (let index = 1; index <= launches; index += 1) {
    variants.push({
      name: `everdrive-${index}`,
      group: "everdrive",
      job: {
        launchFrames: 30 + Math.floor(next() * 90),
        launchCycle: Math.floor(next() * CPU_CYCLES_PER_FRAME),
        ram: "everdrive",
      },
    });
  }
  for (let index = 1; index <= randomRam; index += 1) {
    variants.push({ name: `random-ram-${index}`, group: "cart", job: { ram: `random:${index}` } });
  }
  if (powerOn) {
    for (const startupOffset of [-4, 0, 4, 8]) {
      for (const idleSynch of [false, true]) {
        for (const cpuPhase of [0, 1, 2]) {
          variants.push({
            name: `power-on-${startupOffset}-${idleSynch ? 1 : 0}-${cpuPhase}`,
            group: "cart",
            job: { startupOffset, idleSynch, cpuPhase },
          });
        }
      }
    }
    variants.push({ name: "ram-00", group: "cart", job: { ram: "fill:0" } });
    variants.push({ name: "ram-ff", group: "cart", job: { ram: "fill:255" } });
  }
  if (alignment) {
    // One higher and one lower than the Start delay being checked. From 0, "one lower" drops the
    // first record, which is what an EverDrive launch at Start delay 0 does in strobe mode.
    variants.push({ name: "start-delay+1", group: "alignment", job: { startDelay: startDelay + 1 } });
    variants.push({
      name: "start-delay-1",
      group: "alignment",
      job: startDelay > 0 ? { startDelay: startDelay - 1 } : { skipRecords: 1 },
    });
  }
  for (const overread of overreads) {
    variants.push({ name: `overread-${overread}`, group: "overread", job: { overread } });
  }
  return variants;
}

// A run's job: the base job with the variant's changes. A variant that drops records from the front
// (skipRecords) plays a file whose record j is the checked file's record j + skipRecords, so the
// fields counted in the checked file's records move with it: checkpoints keep the file's numbers, and
// the guard boundary, which the firmware counts from the first record it is sent, comes down. Returns
// the job and the records to drop, which the caller turns into a records file.
function variantJob(baseJob, variant) {
  const { skipRecords = 0, ...fields } = variant.job;
  const job = { ...baseJob, ...fields };
  return {
    skipRecords,
    job: {
      ...job,
      checkpointOffset: (job.checkpointOffset ?? 0) + skipRecords,
      guardUntil: Math.max(0, (job.guardUntil ?? 0) - skipRecords),
    },
  };
}

function isSame(summary) {
  return Boolean(summary && summary.allRecordsServed && summary.endSimilarity !== null && summary.endSimilarity >= SAME_ENDING);
}

function describeRun(summary) {
  if (!summary) {
    return "did not run";
  }
  if (isSame(summary)) {
    return "same ending";
  }
  const parts = [];
  if (!summary.allRecordsServed) {
    parts.push(`used ${summary.recordsServed.toLocaleString("en-US")} of ${summary.records.toLocaleString("en-US")} records`);
  } else if (summary.endSimilarity === null || summary.endSimilarity < 0) {
    // A reference run that never used its last record saved no ending.
    parts.push("used every record; no ending to compare with");
  } else {
    parts.push(`different ending (screens ${Math.round((summary.endSimilarity ?? 0) * 100)}% alike)`);
  }
  if (summary.divergence) {
    parts.push(`screens part near record ${summary.divergence.record.toLocaleString("en-US")}`);
  }
  return parts.join("; ");
}

function tally(results, group) {
  const runs = results.filter((result) => result.variant.group === group);
  return { runs: runs.length, same: runs.filter((result) => isSame(result.summary)).length };
}

function recommendedDelay(mode) {
  // Hardware results: an EverDrive menu launch spends one latch before the game's first, so record
  // 0 on the game's first latch is Start delay 1 in strobe mode. Windowed launches from the menu
  // have matched at 0.
  return mode === "strobe" ? 1 : 0;
}

function verdict(results, context) {
  const base = results.find((result) => result.variant.group === "base");
  const everdrive = tally(results, "everdrive");
  const cart = tally(results, "cart");
  const lines = [];

  const overreadLines = () =>
    results
      .filter((r) => r.variant.group === "overread")
      .map((r) => `With BRIDGE_TAS_OVERREAD=${r.variant.job.overread}: ${describeRun(r.summary)}.`);

  if (!context.hasMovie && !base?.summary?.allRecordsServed) {
    // Without a movie the power-on run is the reference, and one that never used its last record saved
    // no ending, so the other runs can only be told apart by whether they read every record.
    const { recordsServed = 0, records = 0 } = base?.summary ?? {};
    lines.push(
      `From a default power-on the game stops reading the file after ${recordsServed.toLocaleString("en-US")} of its ` +
        `${records.toLocaleString("en-US")} records, so it does not play to its end. That run is the reference, so there is no ending to compare the other runs with.`,
    );
    const reading = [
      ["everdrive", "EverDrive launches"],
      ["cart", "cartridge power-on states"],
    ]
      .map(([group, name]) => {
        const runs = results.filter((result) => result.variant.group === group);
        return runs.length > 0 ? `${name} ${runs.filter((result) => result.summary?.allRecordsServed).length} of ${runs.length}` : null;
      })
      .filter(Boolean);
    if (reading.length > 0) {
      lines.push(`Runs that read every record: ${reading.join(", ")}.`);
    }
    return lines;
  }

  if (!isSame(base?.summary)) {
    lines.push("Does not reach the movie's ending even from a default power-on. The file, its settings, or this BizHawk version does not match the movie.");
    const fixes = results.filter((r) => r.variant.group === "overread" && isSame(r.summary));
    for (const line of overreadLines()) {
      lines.push(line);
    }
    if (fixes.length > 0) {
      lines.push(`Check again with --overread ${fixes[0].variant.job.overread} to see how it plays from EverDrive launches.`);
    }
    return lines;
  }

  if (everdrive.runs > 0) {
    if (everdrive.same === everdrive.runs) {
      lines.push(`Should play from an EverDrive menu launch: ${everdrive.same} of ${everdrive.runs} launches reach the same ending.`);
    } else if (everdrive.same === 0) {
      lines.push(`Unlikely from an EverDrive menu launch: 0 of ${everdrive.runs} launches reach the same ending. A cartridge power-on may behave differently.`);
    } else {
      lines.push(
        `A per-launch lottery on the EverDrive: ${everdrive.same} of ${everdrive.runs} launches reach the same ending (about ${Math.round((100 * everdrive.same) / everdrive.runs)}% per attempt).`,
      );
    }
  }
  if (cart.runs > 0) {
    lines.push(`Cartridge power-on states: ${cart.same + 1} of ${cart.runs + 1} reach the same ending (including the default).`);
  }

  const late = results.find((result) => result.variant.name === "start-delay+1");
  const early = results.find((result) => result.variant.name === "start-delay-1");
  const delay = recommendedDelay(context.mode) + context.startDelay;
  if (late && early) {
    // Below a menu Start delay of 0, the "one lower" run drops the first record: Skip first 1.
    const lower = delay > 0 ? "one lower" : "Skip first 1";
    const tolerant = [isSame(late.summary) && "one higher", isSame(early.summary) && lower].filter(Boolean);
    lines.push(
      tolerant.length === 0
        ? `Start delay must be exact: use ${delay} from the EverDrive menu; one higher or ${delay > 0 ? "lower" : "Skip first 1"} loses.`
        : `Start delay ${delay} from the EverDrive menu; ${tolerant.join(" and ")} also ${tolerant.length > 1 ? "reach" : "reaches"} the ending.`,
    );
  }

  return lines.concat(overreadLines());
}

function movieNotes(movie) {
  const notes = [];
  const perFrame = Object.entries(movie.latchesPerFrame)
    .filter(([count]) => count !== "0")
    .map(([count, frames]) => `${frames.toLocaleString("en-US")} frame(s) with ${count}`)
    .join(", ");
  notes.push(`Latches per polled frame: ${perFrame || "none"}.`);
  const reads = (hist) =>
    Object.entries(hist)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([count, latches]) => `${count} (${latches.toLocaleString("en-US")})`)
      .join(", ");
  notes.push(`Reads per latch, port 1: ${reads(movie.readsPerLatch.port1)}; port 2: ${reads(movie.readsPerLatch.port2)}.`);
  if (movie.overreadLatches > 0) {
    notes.push(
      `${movie.overreadLatches.toLocaleString("en-US")} latch(es) are read past the eighth clock (first at latch ${movie.firstOverreadLatch}). ` +
        "BizHawk and a real controller return 1s there; TASDeck's default returns the next record's A.",
    );
  }
  if (movie.multiLatchFrames > 0) {
    notes.push(
      `${movie.multiLatchFrames.toLocaleString("en-US")} frame(s) strobe more than once. The .r08 in strobe mode spends a record on each strobe; ` +
        "a .tdmask in poll mode serves one mask per frame, which is what keeps DPCM re-read games in sync.",
    );
  }
  if (movie.perLatchInputWithinFrame > 0) {
    notes.push(`Input changes between latches inside one frame (${movie.perLatchInputWithinFrame} frame(s)), so only the .r08 in strobe mode can carry it.`);
  }
  if (movie.oddReads.length > 0) {
    const list = movie.oddReads
      .slice(0, 5)
      .map((read) => `$${read.address.toString(16).toUpperCase().padStart(4, "0")} (PC $${read.pc.toString(16).toUpperCase().padStart(4, "0")}, ${read.count}x)`)
      .join(", ");
    notes.push(`Reads open bus or unmapped space: ${list}. The EverDrive N8 Pro answers these differently from a cartridge.`);
  }
  if (movie.consolePresses.length > 0) {
    const presses = movie.consolePresses
      .slice(0, 3)
      .map((press) => `${press.button} at movie row ${press.row.toLocaleString("en-US")} (after record ${press.afterRecord.toLocaleString("en-US")})`)
      .join(", ");
    const more = movie.consolePresses.length > 3 ? ` and ${movie.consolePresses.length - 3} more` : "";
    notes.push(`The movie presses ${presses}${more}. TASDeck cannot press them; do it by hand at that point. Checks play straight through without them.`);
  }
  if (movie.endUniformity > 0.97) {
    notes.push("The movie's end screen is almost one colour, so a matching ending is weak evidence. Look at the end screens.");
  }
  return notes;
}

module.exports = {
  SAME_ENDING,
  buildVariants,
  describeRun,
  isSame,
  movieNotes,
  random,
  recommendedDelay,
  variantJob,
  verdict,
};
