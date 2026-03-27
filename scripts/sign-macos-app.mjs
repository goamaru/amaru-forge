import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { platform } from 'node:os';
import path from 'node:path';

const defaultAppPath = path.resolve('src-tauri/target/release/bundle/macos/Amaru Forge.app');
const appPath = path.resolve(process.argv[2] || defaultAppPath);

if (platform() !== 'darwin') {
  console.log('[sign:bundle] Skipping macOS signing helper on non-macOS host.');
  process.exit(0);
}

if (!existsSync(appPath)) {
  console.log(`[sign:bundle] No app bundle found at ${appPath}; nothing to sign.`);
  process.exit(0);
}

const identity = (process.env.APPLE_SIGN_IDENTITY || '-').trim() || '-';

function run(command, args) {
  const result = spawnSync(command, args, {
    stdio: 'inherit',
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}`);
  }
}

console.log(`[sign:bundle] Signing ${appPath}`);
console.log(`[sign:bundle] Identity: ${identity === '-' ? 'ad-hoc (-)' : identity}`);

run('codesign', ['--force', '--deep', '--sign', identity, appPath]);
run('codesign', ['--verify', '--deep', '--strict', '--verbose=4', appPath]);

if (identity === '-') {
  console.warn(
    '[sign:bundle] Bundle structure is now valid, but Gatekeeper trust (spctl) still requires a real Apple signing identity.',
  );
}
