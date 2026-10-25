import { afterAll } from 'bun:test';

import { startRedis, testPrefix } from './redis';

// The app's modules read these once, when first imported, and every test file shares the process.
const redis = await startRedis();
process.env.REDIS_URL = redis.url;
process.env.SPLAT_REDIS_PREFIX = testPrefix();
process.env.SPLAT_TOKEN = 'test-token';
process.env.DEMO_PASSWORD = 'open sesame';

afterAll(() => redis.stop());
