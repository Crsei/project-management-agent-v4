import { cp, mkdir } from 'node:fs/promises';
await mkdir('dist/packages/infrastructure', { recursive: true });
await cp('packages/infrastructure/migrations', 'dist/packages/infrastructure/migrations', { recursive: true });
