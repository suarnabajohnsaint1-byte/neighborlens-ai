const { spawn } = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const artifacts = path.join(root, '.data', 'identity-phase21');
const python = process.env.FREUID_DIAGNOSTIC_PYTHON || (process.platform === 'win32'
  ? path.join(root, '.venv', 'Scripts', 'python.exe') : path.join(root, '.venv', 'bin', 'python'));

const child = spawn(python, [
  '-m', 'uvicorn', 'ai.identity.freuid_diagnostic:app', '--host', '127.0.0.1', '--port', '8003',
  '--no-access-log'
], {
  cwd: root,
  env: {
    ...process.env,
    FREUID_ASSETS: process.env.FREUID_ASSETS || path.join(artifacts, 'freuid-a31'),
    FREUID_RESEARCH_LAYOUT: process.env.FREUID_RESEARCH_LAYOUT || 'MAURITIUS/ID',
    PYTHONPATH: [path.join(artifacts, 'deps'), process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
  },
  stdio: 'inherit',
  windowsHide: true
});
child.on('error', error => {
  console.error('Could not start the local FREUID process:', error.code);
  process.exitCode = 1;
});
child.on('exit', code => { process.exitCode = code ?? 1; });
