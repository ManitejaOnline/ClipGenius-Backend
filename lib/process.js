const { spawn } = require("child_process");

// yt-dlp.exe runs as a launcher plus a child process, so the whole tree must be killed
const killProcessTree = (proc) => {
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"]);
  } else {
    proc.kill("SIGKILL");
  }
};

const runProcess = (command, args, { timeoutMs, timeoutMessage, cwd, onStdoutLine } = {}) =>
  new Promise((resolve, reject) => {
    const proc = spawn(command, args, { cwd });
    let stdout = "";
    let stderr = "";
    let pendingLine = "";

    proc.stdout.setEncoding("utf8");
    proc.stderr.setEncoding("utf8");
    proc.stdout.on("data", (chunk) => {
      if (!onStdoutLine) {
        stdout += chunk;
        return;
      }
      const lines = (pendingLine + chunk).split(/\r?\n/);
      pendingLine = lines.pop();
      lines.forEach(onStdoutLine);
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    const timer = setTimeout(() => {
      killProcessTree(proc);
      reject(new Error(timeoutMessage || `${command} timed out`));
    }, timeoutMs);

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (onStdoutLine && pendingLine) onStdoutLine(pendingLine);
      if (code === 0) resolve(stdout);
      else reject(Object.assign(new Error(`${command} exited with code ${code}`), { stderr }));
    });
  });

module.exports = { runProcess };
