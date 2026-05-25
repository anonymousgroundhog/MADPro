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
 *   filterRe   RegExp  — suppress lines matching this regex on stderr
 *   prefix     string  — prefix for stderr lines (default "[ERR]")
 *   quiet      boolean — suppress all stdout and stderr output
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

    // Split on \n but also strip embedded \r from progress-style output
    function splitLines(buf) {
      const lines = buf.split("\n");
      const remainder = lines.pop();
      return { lines: lines.map(l => l.replace(/\r/g, "").trim()).filter(Boolean), remainder };
    }

    proc.stdout.on("data", d => {
      if (opts.quiet) return;
      stdoutBuf += d.toString();
      const { lines, remainder } = splitLines(stdoutBuf);
      stdoutBuf = remainder;
      lines.forEach(l => console.log(l));
    });

    proc.stderr.on("data", d => {
      stderrBuf += d.toString();
      if (opts.quiet) return;
      const { lines, remainder } = splitLines(stderrBuf);
      stderrBuf = remainder;
      lines.forEach(l => {
        if (opts.filterSoot && SOOT_NOISE_RE.test(l)) return;
        if (opts.filterRe && opts.filterRe.test(l)) return;
        console.error((opts.prefix || "[ERR]") + " " + l);
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
      if (!opts.quiet) {
        flush(stdoutBuf, "");
        flush(stderrBuf, opts.prefix || "[ERR]");
      }
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
