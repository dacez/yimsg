import fs from 'fs';
import type { FullConfig } from '@playwright/test';

export default async function globalTeardown(_config: FullConfig) {
  const pid = process.env.TEST_SERVER_PID;
  if (pid) {
    try {
      process.kill(Number(pid), 'SIGTERM');
      console.log(`[globalTeardown] Server (PID ${pid}) stopped.`);
    } catch {}
  }
  const testEnvDir = process.env.TEST_ENV_DIR;
  if (testEnvDir) {
    for (let i = 0; i < 10; i++) {
      try {
        fs.rmSync(testEnvDir, { recursive: true, force: true });
        break;
      } catch {
        await new Promise(resolve => setTimeout(resolve, 300));
      }
    }
  }
}
