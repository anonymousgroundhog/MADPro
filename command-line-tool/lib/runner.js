/**
 * lib/runner.js
 * Spawn subprocesses and stream output to stdout in real time.
 */

const { spawn } = require("child_process");

const SOOT_NOISE_RE = /TypePromotionUseVisitor|Failed Typing in|GC\(\d+\)|gc,start|gc,task|gc,phases|gc,heap|gc,metaspace|gc,cpu|Pause Young|Pause Full|Evacuation Pause|Using \d+ workers/;

/**
 * Spawn cmd with args, stream stdout/stderr to console.
 * Returns Promise<boolean> — true if exit code 0.
 *
 * opts:
 *   cwd        string
 *   timeoutMs  number  — hard wall-clock kill (0 = none)
 *   stuckMs    number  — kill if no output for N ms (0 = none)
 *   filterSoot boolean — suppress Soot GC noise on stderr
 *   prefix     string  — prefix for stderr lines (default "[ERR]")
 */
function run(cmd, args, opts = {}) {
  return new Promise(resolve => {
    const proc = spawn(cmd, args, {
      cwd: opts.cwd || process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdoutBuf = "";
    let stderrBuf = "";
    const flush = (buf, prefix) => {
      if (buf.trim()) process.stdout.write((prefix ? prefix + " " : "") + buf.trim() + "\n");
      return "";
    };

    proc.stdout.on("data", d => {
      stdoutBuf += d.toString();
      const lines = stdoutBuf.split("\n");
      stdoutBuf = lines.pop();
      lines.forEach(l => { if (l.trim()) console.log(l.trim()); });
    });

    proc.stderr.on("data", d => {
      stderrBuf += d.toString();
      const lines = stderrBuf.split("\n");
      stderrBuf = lines.pop();
      lines.forEach(l => {
        if (!l.trim()) return;
        if (opts.filterSoot && SOOT_NOISE_RE.test(l)) return;
        console.error((opts.prefix || "[ERR]") + " " + l.trim());
      });
    });

    let killTimer = null;
    let stuckTimer = null;
    let lastOut = Date.now();

    if (opts.timeoutMs > 0) {
      killTimer = setTimeout(() => {
        console.error(`[TIMEOUT] Killed after ${opts.timeoutMs}ms`);
        try { proc.kill("SIGTERM"); } catch {}
        setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} }, 5000);
      }, opts.timeoutMs);
    }

    if (opts.stuckMs > 0) {
      stuckTimer = setInterval(() => {
        if (Date.now() - lastOut >= opts.stuckMs) {
          console.error(`[TIMEOUT] No output for ${opts.stuckMs / 1000}s — killing`);
          clearInterval(stuckTimer);
          try { proc.kill("SIGTERM"); } catch {}
        }
        lastOut = Date.now();
      }, opts.stuckMs);
    }

    proc.on("close", code => {
      if (killTimer) clearTimeout(killTimer);
      if (stuckTimer) clearInterval(stuckTimer);
      flush(stdoutBuf, "");
      flush(stderrBuf, opts.prefix || "[ERR]");
      resolve(code === 0);
    });

    proc.on("error", err => {
      if (killTimer) clearTimeout(killTimer);
      if (stuckTimer) clearInterval(stuckTimer);
      console.error("ERROR:", err.message);
      resolve(false);
    });
  });
}

module.exports = { run };
