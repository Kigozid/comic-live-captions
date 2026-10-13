import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const apiDirectory = dirname(fileURLToPath(import.meta.url));

try {
  process.loadEnvFile(join(apiDirectory, '..', '.env'));
} catch (error) {
  if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
    throw error;
}

const { startApiServer } = await import('./server.js');
startApiServer();

export {};
