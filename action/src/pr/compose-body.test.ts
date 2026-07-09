import { describe, expect, it } from 'vitest';
import { loadFixtureCaseFileSync } from '../../tests/helpers/fixtures.js';
import type { CaseFile } from '../case-file/types.js';
import { classifyTier } from '../tier/classify.js';
import { resolveAutonomy } from '../tier/resolve-autonomy.js';
import type { VerificationObservation } from '../verification/observation.js';
import type { ComposePrBodyInput } from './compose-body.js';
import { composePrBody } from './compose-body.js';

const loadCaseFile = (name: string): CaseFile => loadFixtureCaseFileSync(name);

const observation: VerificationObservation = {
  runner: 'node',
  artifactPaths: ['src/routes/pay.counterfactual.test.ts'],
  serverProcessSpawned: false,
  httpExercised: false,
  browserExercised: false,
  dataPath: 'fixture-only',
  originalRun: { passed: false, failureSignature: 'exit 1: AssertionError: charge total mismatch' },
  patchedRun: { passed: true },
};

const baseInput = (): ComposePrBodyInput => ({
  caseFile: loadCaseFile('node-api-500.json'),
  observation,
  tier: classifyTier(observation),
  autonomy: resolveAutonomy('pr', 1),
  verificationRunLinks: {
    originalRun: 'https://github.com/example-org/shop-api/actions/runs/9001',
    patchedRun: 'https://github.com/example-org/shop-api/actions/runs/9002',
  },
  agentIdentity: { agent: 'fake-adapter', model: 'scripted-v1' },
});

describe('composePrBody', () => {
  it('contains every §7.2-required element and the word "proven" nowhere', () => {
    const body = composePrBody(baseInput());

    expect(body).toContain('https://github.com/example-org/shop-api/issues/1301');
    expect(body).toContain('12');
    expect(body).toContain('production');

    expect(body).toContain('src/routes/pay.counterfactual.test.ts');

    expect(body).toContain('https://github.com/example-org/shop-api/actions/runs/9001');
    expect(body).toContain('https://github.com/example-org/shop-api/actions/runs/9002');

    expect(body).toContain('Tier 1');
    expect(body).toContain('fixture_only_data_path');

    expect(body).toContain('fake-adapter');
    expect(body).toContain('scripted-v1');

    expect(body).not.toMatch(/proven/i);
  });

  it('includes the downgrade annotation when autonomy was downgraded', () => {
    const input = baseInput();
    const body = composePrBody(input);
    if (!input.autonomy.downgraded) throw new Error('pr + tier 1 must be downgraded');
    expect(body).toContain(input.autonomy.annotation);
  });

  it('omits the downgrade section when autonomy was not downgraded', () => {
    const body = composePrBody({ ...baseInput(), autonomy: resolveAutonomy('pr', 2) });
    expect(body).not.toContain('downgrade');
    expect(body).not.toContain('Downgrade');
  });

  it('never adds raw payload fields from the representative occurrence', () => {
    const body = composePrBody(baseInput());
    expect(body).not.toContain("Cannot read properties of null (reading 'customer_id')");
    expect(body).not.toContain('cart_redacted');
    expect(body).not.toContain('POST /api/pay');
  });

  it('renders case-file-derived values as quoted data', () => {
    const body = composePrBody(baseInput());
    expect(body).toContain('`api@2.1.0`');
    expect(body).toContain('`https://github.com/example-org/shop-api/issues/1301`');
    expect(body).toContain('`production`');
  });

  it('reports both run outcomes alongside their links', () => {
    const body = composePrBody(baseInput());
    expect(body).toMatch(/expected FAIL/);
    expect(body).toMatch(/expected PASS/);
    expect(body).toContain('exit 1: AssertionError: charge total mismatch');
  });
});
