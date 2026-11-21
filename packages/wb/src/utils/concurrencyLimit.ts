import { createConcurrencyLimiter } from '@willbooster/shared-lib/src';

export const runWithConcurrencyLimit = createConcurrencyLimiter(10);
