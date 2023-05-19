import * as fs from 'fs';
import * as path from 'path';
import { describe, it, assert } from 'vitest';
import { try_load_config, should_update_expected } from '../helpers.js';
import * as svelte from 'svelte/compiler';

describe('js-output', () => {
	fs.readdirSync(`${__dirname}/samples`).forEach((dir) => {
		if (dir[0] === '.') return;

		// add .solo to a sample directory name to only run that test
		const solo = /\.solo/.test(dir);

		const resolved = path.resolve(`${__dirname}/samples`, dir);

		const skip = !fs.existsSync(`${resolved}/input.svelte`);
		if (skip) {
			console.warn(
				`Missing file ${dir}/input.svelte. If you recently switched branches you may need to delete this directory`
			);
		}

		const it_fn = solo ? it.only : skip ? it.skip : it;

		it_fn(dir, async () => {
			const config = await try_load_config(`${resolved}/_config.js`);

			const input = fs
				.readFileSync(`${resolved}/input.svelte`, 'utf-8')
				.trimEnd()
				.replace(/\r/g, '');

			let actual;

			try {
				const options = Object.assign({}, config.options || {});

				actual = svelte
					.compile(input, options)
					.js.code.replace(/generated by Svelte v__VERSION__/, 'generated by Svelte vX.Y.Z');
			} catch (err) {
				console.log(err.frame);
				throw err;
			}

			const output = `${resolved}/_actual.js`;
			fs.writeFileSync(output, actual);

			const expected_path = `${resolved}/expected.js`;

			let expected = '';
			try {
				expected = fs.readFileSync(expected_path, 'utf-8');
			} catch (error) {
				console.log(error);
				if (error.code === 'ENOENT') {
					// missing expected.js
					fs.writeFileSync(expected_path, actual);
				}
			}

			try {
				assert.equal(normalize_output(actual), normalize_output(expected));
			} catch (error) {
				if (should_update_expected()) {
					fs.writeFileSync(expected_path, actual);
					console.log(`Updated ${expected_path}.`);
				} else {
					throw error;
				}
			}
		});
	});
});

function normalize_output(str) {
	return str
		.trim()
		.replace(/^[ \t]+$/gm, '')
		.replace(/\r/g, '');
}
