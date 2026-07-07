/**
 * PR body composition (product PRD §7.2): case-file summary, artifact,
 * both verification run links, tier + mechanical classification, agent/model.
 * Case-file-derived text is rendered as quoted data (scrubbed upstream, §9);
 * the composer never adds raw payload fields from representative_occurrence.
 */

import type { CaseFile } from '../case-file/types.js';
import type { TierClassification } from '../tier/classify.js';
import type { AutonomyResolution } from '../tier/resolve-autonomy.js';
import type { RunOutcome, VerificationObservation } from '../verification/observation.js';

export interface VerificationRunLinks {
  originalRun: string;
  patchedRun: string;
}

export interface AgentIdentity {
  agent: string;
  model: string;
}

export interface ComposePrBodyInput {
  caseFile: CaseFile;
  observation: VerificationObservation;
  tier: TierClassification;
  autonomy: AutonomyResolution;
  verificationRunLinks: VerificationRunLinks;
  agentIdentity: AgentIdentity;
}

const quote = (value: string): string => `\`${value}\``;

const caseFileSummary = (caseFile: CaseFile): string => {
  const { group, release, work_item } = caseFile;
  return [
    '## Case-file summary',
    '',
    `- Work item: ${quote(work_item.url)} (${quote(work_item.kind)} ${quote(work_item.id)})`,
    `- Occurrences: ${quote(String(group.occurrence_count))} between ${quote(group.first_seen)} and ${quote(group.last_seen)}`,
    `- Environments: ${group.environments.map(quote).join(', ')}`,
    `- Release: ${quote(release.declared)} at revision ${quote(release.revision ?? 'unresolved')}`,
  ].join('\n');
};

const artifactSection = (observation: VerificationObservation): string =>
  [
    '## Counterfactual artifact',
    '',
    ...observation.artifactPaths.map((path) => `- ${quote(path)}`),
  ].join('\n');

const outcomeLabel = (run: RunOutcome): string =>
  run.passed ? 'passed' : `failed with ${quote(run.failureSignature)}`;

const verificationSection = (
  observation: VerificationObservation,
  links: VerificationRunLinks,
): string =>
  [
    '## Verification runs',
    '',
    `- Original revision (expected FAIL): ${outcomeLabel(observation.originalRun)} — ${links.originalRun}`,
    `- Patched revision (expected PASS): ${outcomeLabel(observation.patchedRun)} — ${links.patchedRun}`,
  ].join('\n');

const tierSection = (tier: TierClassification, observation: VerificationObservation): string =>
  [
    '## Evidence tier',
    '',
    `- Tier ${String(tier.tier)}, classified mechanically from the verification runs (runner ${quote(observation.runner)})`,
    `- Classification reasons: ${tier.reasons.map(quote).join(', ')}`,
  ].join('\n');

const agentSection = (identity: AgentIdentity): string =>
  [
    '## Agent',
    '',
    `- Agent: ${quote(identity.agent)}`,
    `- Model: ${quote(identity.model)}`,
  ].join('\n');

const downgradeSection = (annotation: string): string =>
  ['## Autonomy downgrade', '', `> ${annotation}`].join('\n');

export const composePrBody = (input: ComposePrBodyInput): string => {
  const sections = [
    'Amends opened this pull request with a validated, evidence-backed fix.',
    caseFileSummary(input.caseFile),
    artifactSection(input.observation),
    verificationSection(input.observation, input.verificationRunLinks),
    tierSection(input.tier, input.observation),
    agentSection(input.agentIdentity),
  ];
  if (input.autonomy.downgraded) {
    sections.push(downgradeSection(input.autonomy.annotation));
  }
  return sections.join('\n\n');
};
