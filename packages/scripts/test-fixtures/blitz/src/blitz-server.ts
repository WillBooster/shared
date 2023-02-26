/* eslint-disable */

import {setupBlitzServer} from '@blitzjs/next';
import {BlitzLogger} from 'blitz';

export const { api } = setupBlitzServer({
	plugins: [],
	logger: BlitzLogger({})
});
