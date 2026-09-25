// TEST-ONLY (a vitest `setupFiles` entry, see vitest.config.ts): jsdom and Node have no OPFS,
// and on web without it `productCacheStorage()` throws `UnsupportedStorageError`, so test runs
// use memory storage instead. Production never calls this.
import { useMemoryStorageForTests } from '../lib/web-storage';

useMemoryStorageForTests();
