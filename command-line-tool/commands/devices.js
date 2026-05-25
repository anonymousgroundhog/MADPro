/**
 * commands/devices.js
 * `madpro devices` — list connected ADB devices and AVDs.
 */

const { execSync, spawnSync } = require("child_process");
const { findAdb, findBin } = require("../lib/tools");

function listAdbDevices() {
  try {
    const adb = findAdb() || "adb";
    const out = execSync(`"${adb}" devices -l`, { encoding: "utf8", timeout: 8000 });
    return out.split("\n").slice(1)
      .filter(l => l.trim() && !l.startsWith("*"))
      .map(l => {
        const parts = l.trim().split(/\s+/);
        const serial = parts[0];
        const state  = parts[1];
        const model  = (l.match(/model:(\S+)/) || [])[1] || serial;
        const type   = serial.startsWith("emulator") ? "emulator" : "device";
        return { serial, state, model, type };
      })
      .filter(d => d.state === "device");
  } catch { return []; }
}

function listAvds() {
  try {
    const out = execSync(
      "emulator -list-avds 2>/dev/null || avdmanager list avd -c 2>/dev/null",
      { encoding: "utf8", shell: true, timeout: 10000 }
    );
    return out.split("\n").map(l => l.trim()).filter(Boolean);
  } catch { return []; }
}

function register(program) {
  program
    .command("devices")
    .description("List connected ADB devices and available AVDs")
    .action(() => {
      const devices = listAdbDevices();
      const avds = listAvds();

      console.log("\nConnected devices:");
      if (!devices.length) {
        console.log("  (none)");
      } else {
        for (const d of devices) {
          console.log(`  ${d.serial}  [${d.type}]  model=${d.model}`);
        }
      }

      console.log("\nAvailable AVDs:");
      if (!avds.length) {
        console.log("  (none)");
      } else {
        for (const a of avds) console.log(`  ${a}`);
      }
      console.log();
    });
}

module.exports = { register, listAdbDevices, listAvds };
