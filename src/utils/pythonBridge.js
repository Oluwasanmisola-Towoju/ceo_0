// runs a python worker script as a subprocess, sends it a JSON payload on stdin and resolves
// with the JSON payload the script prints on stdout

const { spawn } = require('child_process');
const path = require('path');

const WORKERS_DIR = path.resolve(process.env.WORKERS_DIR || './workers');
const PYTHON_BIN = process.env.PYTHON_BIN || 'python3';
const DEFAULT_TIMEOUT_MS = Number(process.env.PYTHON_TIMEOUT_MS || 3000);
const SAFE_SCRIPT_NAME = /^[a-zA-Z0-9_-]+\.py$/;

// invoke a python worker with a JSON payload and get a JSON payload back
function runPythonWorker(scriptName, payload, opts = {}) {
    const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;

    if (!SAFE_SCRIPT_NAME.test(scriptName)) {
        return Promise.reject(new Error(`[pythonBridge] Invalid script name: ${scriptName}`));
    }

    const scriptPath = path.join(WORKERS_DIRS, scriptName);
    if (!scriptPath.startsWith(WORKERS_DIR + path.sep)) {
        return Promise.reject(new Error(`[pythonBridge] Script path escapes WORKERS_DIR: ${scriptName}`));
    }

    return new Promise((resolve, reject) => {
        const child = spawn(PYTHON_BIN, [scriptPath], {
            cwd: WORKERS_DIR,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: {
                PATH: process.env.PATH,
                LLM_API_KEY: process.env.LLM_API_KEY || '',
                LLM_MODEL: process.env.LLM_MODEL || ''
            }
        });

        let stdout = '';
        let stderr = '';
        let settled = false;

        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            child.kill('SIGKILL');
            reject(new Error(`[pythonBridge] ${scriptName} timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stdout += chunk; });

        child.on('error', (err) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(new Error(`[pythonBridge] Failed to spawn ${scriptName}: ${err.message}`));
        });

        child.on('close', (code) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);


            if (code != 0) {
                reject(new Error(`[pythonBridge] ${scriptName} exited ${code}. stderr: ${stderr.trim()}`));
                return;
            }
            try {
                resolve(JSON.parse(stdout));
            }
            catch (err) {
                reject(new Error(
                    `[pythonBridge] ${scriptName} did not return valid JSON on stdout.\n` +
                    `stdout: ${stdout.slice(0, 500)}\nstderr: ${stderr.slice(0, 500)}`
                ));
            }
        });

        // send payload and close stdin so the worker should read until EOF
        child.stdin.write(JSON.stringify(payload));
        child.stdin.end();
    });
}

module.exports = { runPythonWorker };