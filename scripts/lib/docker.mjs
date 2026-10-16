// Runs Docker either natively or through WSL (Docker Engine on this workstation lives inside WSL).
// Set PSACC_WSL_DISTRO to pick a distro; set PSACC_DOCKER_NATIVE=1 to force the native CLI.
import { spawnSync } from 'node:child_process';

function nativeDockerAvailable() {
  if (process.env.PSACC_DOCKER_NATIVE === '1') return true;
  const r = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8', shell: false });
  return r.status === 0;
}

let mode;
export function dockerMode() {
  if (!mode) mode = nativeDockerAvailable() ? 'native' : process.platform === 'win32' ? 'wsl' : 'native';
  return mode;
}

/** Run `docker <args>` with cwd = dir. Returns the spawnSync result. */
export function docker(args, { cwd, stdio = 'inherit', input } = {}) {
  if (dockerMode() === 'native') {
    return spawnSync('docker', args, { cwd, stdio, input, encoding: 'utf8' });
  }
  const wslArgs = [];
  if (process.env.PSACC_WSL_DISTRO) wslArgs.push('-d', process.env.PSACC_WSL_DISTRO);
  if (cwd) wslArgs.push('--cd', cwd);
  wslArgs.push('--exec', 'docker', ...args);
  return spawnSync('wsl', wslArgs, { stdio, input, encoding: 'utf8' });
}
