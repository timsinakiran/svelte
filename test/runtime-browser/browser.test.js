import { chromium } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { rollup } from 'rollup';
import { mkdirp, pretty_print_browser_assertion, try_load_config } from '../helpers.js';
import * as svelte from 'svelte/compiler';
import { beforeAll, describe, afterAll, assert, it } from 'vitest';

const internal = path.resolve('src/runtime/internal/index.js');
const index = path.resolve('src/runtime/index.js');

const main = fs.readFileSync(`${__dirname}/driver.js`, 'utf-8');
const browser_assert = fs.readFileSync(`${__dirname}/assert.js`, 'utf-8');

/** @type {import('@playwright/test').Browser} */
let browser;

beforeAll(async () => {
	browser = await chromium.launch();
	console.log('[runtime-browser] Launched browser');
}, 20000);

afterAll(async () => {
	if (browser) await browser.close();
});

describe(
	'runtime (browser)',
	async () => {
		const failed = new Set();

		async function run_test(dir, hydrate) {
			if (dir[0] === '.') return;

			const cwd = `${__dirname}/samples/${dir}`;

			// TODO: Vitest currently doesn't register a watcher because the import is hidden
			const config = await try_load_config(`${cwd}/_config.js`);
			const solo = config.solo || /\.solo/.test(dir);
			const skip = config.skip || /\.skip/.test(dir);

			if (hydrate && config.skip_if_hydrate) return;

			const it_fn = skip ? it.skip : solo ? it.only : it;

			it_fn(`${dir} ${hydrate ? '(with hydration)' : ''}`, async () => {
				if (failed.has(dir)) {
					// this makes debugging easier, by only printing compiled output once
					assert.fail('skipping test, already failed');
				}

				const warnings = [];

				const bundle = await rollup({
					input: 'main',

					plugins: [
						{
							name: 'testing-runtime-browser',
							resolveId(importee) {
								if (importee === 'svelte/internal' || importee === './internal') {
									return internal;
								}

								if (importee === 'svelte') {
									return index;
								}

								if (importee === 'main') {
									return 'main';
								}

								if (importee === 'assert') {
									return 'assert';
								}

								if (importee === '__MAIN_DOT_SVELTE__') {
									return path.resolve(__dirname, 'samples', dir, 'main.svelte');
								}

								if (importee === '__CONFIG__') {
									return path.resolve(__dirname, 'samples', dir, '_config.js');
								}
							},
							load(id) {
								if (id === 'assert') return browser_assert;

								if (id === 'main') {
									return main.replace('__HYDRATE__', hydrate ? 'true' : 'false');
								}
							},

							transform(code, id) {
								if (id.endsWith('.svelte')) {
									const compiled = svelte.compile(code.replace(/\r/g, ''), {
										...config.compileOptions,
										hydratable: hydrate,
										immutable: config.immutable,
										accessors: 'accessors' in config ? config.accessors : true
									});

									const out_dir = `${cwd}/_output/${hydrate ? 'hydratable' : 'normal'}`;
									const out = `${out_dir}/${path.basename(id).replace(/\.svelte$/, '.js')}`;

									mkdirp(out_dir);

									fs.writeFileSync(out, compiled.js.code, 'utf8');

									compiled.warnings.forEach((w) => warnings.push(w));

									return compiled.js;
								}
							}
						}
					]
				});

				const generated_bundle = await bundle.generate({ format: 'iife', name: 'test' });

				function assertWarnings() {
					if (config.warnings) {
						assert.deepStrictEqual(
							warnings.map((w) => ({
								code: w.code,
								message: w.message,
								pos: w.pos,
								start: w.start,
								end: w.end
							})),
							config.warnings
						);
					} else if (warnings.length) {
						failed.add(dir);
						/* eslint-disable no-unsafe-finally */
						throw new Error('Received unexpected warnings');
					}
				}

				try {
					const page = await browser.newPage();
					page.on('console', (type) => {
						console[type.type()](type.text());
					});
					await page.setContent('<main></main>');
					await page.evaluate(generated_bundle.output[0].code);
					const test_result = await page.evaluate(`test(document.querySelector('main'))`);

					if (test_result) console.log(test_result);
					assertWarnings();
					await page.close();
				} catch (err) {
					failed.add(dir);
					pretty_print_browser_assertion(err.message);
					assertWarnings();
					throw err;
				}
			});
		}

		await Promise.all(
			fs.readdirSync(`${__dirname}/samples`).map(async (dir) => {
				await run_test(dir, false);
				await run_test(dir, true);
			})
		);
	},
	// Browser tests are brittle and slow on CI
	{ timeout: 20000, retry: process.env.CI ? 1 : 0 }
);

describe(
	'custom-elements',
	async () => {
		async function run_test(dir) {
			if (dir[0] === '.') return;
			const cwd = `${__dirname}/custom-elements-samples/${dir}`;

			const solo = /\.solo$/.test(dir);
			const skip = /\.skip$/.test(dir);

			const warnings = [];
			const it_fn = solo ? it.only : skip ? it.skip : it;

			it_fn(dir, async () => {
				// TODO: Vitest currently doesn't register a watcher because the import is hidden
				const config = await try_load_config(`${cwd}/_config.js`);

				const expected_warnings = config.warnings || [];

				const bundle = await rollup({
					input: `${cwd}/test.js`,

					plugins: [
						{
							name: 'plugin-resolve-svelte',
							resolveId(importee) {
								if (importee === 'svelte/internal' || importee === './internal') {
									return internal;
								}

								if (importee === 'svelte') {
									return index;
								}

								if (importee === 'assert') {
									return 'assert';
								}
							},

							load(id) {
								if (id === 'assert') return browser_assert;
							},

							transform(code, id) {
								if (id.endsWith('.svelte')) {
									const compiled = svelte.compile(code.replace(/\r/g, ''), {
										customElement: true,
										dev: config.dev
									});

									compiled.warnings.forEach((w) => warnings.push(w));

									return compiled.js;
								}
							}
						}
					]
				});

				const generated_bundle = await bundle.generate({ format: 'iife', name: 'test' });

				function assertWarnings() {
					if (expected_warnings) {
						assert.deepStrictEqual(
							warnings.map((w) => ({
								code: w.code,
								message: w.message,
								pos: w.pos,
								start: w.start,
								end: w.end
							})),
							expected_warnings
						);
					}
				}

				const page = await browser.newPage();
				page.on('console', (type) => {
					console[type.type()](type.text());
				});
				await page.setContent('<main></main>');
				await page.evaluate(generated_bundle.output[0].code);
				const test_result = await page.evaluate(`test(document.querySelector('main'))`);

				if (test_result) console.log(test_result);

				assertWarnings();

				await page.close();
			});
		}

		await Promise.all(
			fs.readdirSync(`${__dirname}/custom-elements-samples`).map((dir) => run_test(dir))
		);
	},
	// Browser tests are brittle and slow on CI
	{ timeout: 20000, retry: process.env.CI ? 1 : 0 }
);
