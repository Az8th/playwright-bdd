/**
 * Helper to format Playwright test file.
 */

import { PickleStepArgument } from '@cucumber/messages';
import { BDDConfig } from '../config';
import { jsStringWrap } from '../utils/jsStringWrap';
import { TestNode } from './testNode';
import { BddWorldFixtures } from '../run/bddWorld';
import { TestMetaBuilder } from './testMeta';
import { toPosixPath } from '../utils';
import { playwrightVersion } from '../playwright/utils';
import { DescribeConfigureOptions } from '../playwright/types';

const supportsTags = playwrightVersion >= '1.42.0';

export type ImportTestFrom = {
  file: string;
  varName?: string;
};

export class Formatter {
  constructor(private config: BDDConfig) {}

  fileHeader(featureUri: string, importTestFrom?: ImportTestFrom) {
    // always use "/" for imports, see #91
    const importTestFromFile = toPosixPath(importTestFrom?.file || 'playwright-bdd');
    let varName = importTestFrom?.varName || 'test';
    if (varName !== 'test') varName = `${varName} as test`;
    return [
      `/** Generated from: ${featureUri} */`, // prettier-ignore
      // this.quoted() is not possible for 'import from' as backticks not parsed
      `import { ${varName} } from ${JSON.stringify(importTestFromFile)};`,
      '',
    ];
  }

  describe(node: TestNode, children: string[]) {
    const firstLine = `test.${this.getFunction('describe', node)}(${this.quoted(node.title)}, () => {`;
    if (!children.length) return [`${firstLine}});`, ''];
    return [
      firstLine, // prettier-ignore
      ...this.describeConfigure(node).map(indent),
      '',
      ...children.map(indent),
      `});`,
      '',
    ];
  }

  beforeEach(fixtures: Set<string>, children: string[]) {
    const fixturesStr = [...fixtures].join(', ');
    // prettier-ignore
    return [
      `test.beforeEach(async ({ ${fixturesStr} }) => {`,
      ...children.map(indent),
      `});`,
      '',
    ];
  }

  test(node: TestNode, fixtures: Set<string>, children: string[]) {
    const fixturesStr = [...fixtures].join(', ');
    const title = this.quoted(node.title);
    const tags = this.testTags(node);
    const firstLine = `${this.getFunction('test', node)}(${title}, ${tags}async ({ ${fixturesStr} }) => {`;
    if (!children.length) return [`${firstLine}});`, ''];
    const lines = [
      firstLine, // prettier-ignore
      ...children.map(indent),
      `});`,
      '',
    ];
    // wrap test into anonymous describe in case of retries / timeout tags
    const specialTagsConfigure = this.describeConfigure(node);
    return specialTagsConfigure.length
      ? [
          'test.describe(() => {', // prettier-ignore
          ...specialTagsConfigure.map(indent),
          '',
          ...lines.map(indent),
          `});`,
          '',
        ]
      : lines;
  }

  // eslint-disable-next-line max-params
  step(keyword: string, text: string, argument?: PickleStepArgument, fixtureNames: string[] = []) {
    const fixtures = fixtureNames.length ? `{ ${fixtureNames.join(', ')} }` : '';
    const argumentArg = argument ? JSON.stringify(argument) : fixtures ? 'null' : '';
    const textArg = this.quoted(text);
    const args = [textArg, argumentArg, fixtures].filter((arg) => arg !== '').join(', ');
    return `await ${keyword}(${args});`;
  }

  missingStep(keyword: string, text: string) {
    return `// missing step: ${keyword}(${this.quoted(text)});`;
  }

  technicalSection(testMetaBuilder: TestMetaBuilder, featureUri: string, fixtures: string[]) {
    return [
      '// == technical section ==', // prettier-ignore
      '',
      'test.use({',
      ...[
        '$test: ({}, use) => use(test),',
        '$testMetaMap: ({}, use) => use(testMetaMap),',
        `$uri: ({}, use) => use(${this.quoted(featureUri)}),`,
        ...fixtures,
      ].map(indent),
      '});',
      '',
      'const testMetaMap = {',
      ...testMetaBuilder.getObjectLines().map(indent),
      '};',
    ];
  }

  /**
   * These fixtures are added only in Cucumber-style
   */
  bddWorldFixtures() {
    const fixturesObj: Record<keyof BddWorldFixtures, null> = {
      page: null,
      context: null,
      browser: null,
      browserName: null,
      request: null,
    };
    const fixtures = Object.keys(fixturesObj).join(', ');
    return [`$bddWorldFixtures: ({ ${fixtures} }, use) => use({ ${fixtures} }),`];
  }

  scenarioHookFixtures(fixtureNames: string[]) {
    if (!fixtureNames.length) return [];
    const fixtures = fixtureNames.join(', ');
    return [`$scenarioHookFixtures: ({ ${fixtures} }, use) => use({ ${fixtures} }),`];
  }

  workerHookFixtures(fixtureNames: string[]) {
    if (!fixtureNames.length) return [];
    const fixtures = fixtureNames.join(', ');
    const scope = this.quoted('worker');
    return [
      `$workerHookFixtures: [({ ${fixtures} }, use) => use({ ${fixtures} }), { scope: ${scope} }],`,
    ];
  }

  langFixture(lang: string) {
    return [`$lang: ({}, use) => use(${this.quoted(lang)}),`];
  }

  // eslint-disable-next-line complexity
  private getFunction(baseFn: 'test' | 'describe', node: TestNode) {
    if (node.specialTags.only) return `${baseFn}.only`;
    // describe.fail is not supported
    if (baseFn === 'test' && node.specialTags.fail) return `${baseFn}.fail`;
    if (node.specialTags.skip) return `${baseFn}.skip`;
    if (node.specialTags.fixme) return `${baseFn}.fixme`;
    return baseFn;
  }

  private describeConfigure(node: TestNode) {
    const options: DescribeConfigureOptions = {};
    const { retries, timeout, mode } = node.specialTags;
    if (retries !== undefined) options.retries = retries;
    if (timeout !== undefined) options.timeout = timeout;
    if (mode !== undefined) options.mode = mode;
    return Object.keys(options).length
      ? [`test.describe.configure(${JSON.stringify(options)});`]
      : [];
  }

  private testTags(node: TestNode) {
    return supportsTags && node.tags.length
      ? `{ tag: [${node.tags.map((tag) => this.quoted(tag)).join(', ')}] }, `
      : '';
  }

  private testTimeout(node: TestNode) {
    const { timeout } = node.specialTags;
    return timeout !== undefined ? [`test.setTimeout(${timeout});`] : [];
  }

  /**
   * Apply this function only to string literals (mostly titles here).
   * Objects and arrays are handled with JSON.strinigfy,
   * b/c object keys can't be in backticks.
   * See: https://stackoverflow.com/questions/33194138/template-string-as-object-property-name
   */
  private quoted(str: string) {
    return jsStringWrap(str, { quotes: this.config.quotes });
  }
}

function indent(value: string) {
  return value ? `${'  '}${value}` : value;
}
