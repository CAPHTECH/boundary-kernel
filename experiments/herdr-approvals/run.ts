/**
 * 実地テスト: 2026-08-09 のセッションで、オーケストレータが Herdr ワーカーの
 * シェルコマンド要求に対して手作業で下した承認判断を、RBK が再現できるか。
 *
 *   node --experimental-strip-types experiments/herdr-approvals/run.ts
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decide } from '../../src/decide.ts';
import { actionDigest, evidenceStateDigest } from '../../src/digest.ts';
import type { Policy, Request } from '../../src/types.ts';

const here = dirname(fileURLToPath(import.meta.url));
const policy = JSON.parse(readFileSync(join(here, 'policy.json'), 'utf8')) as Policy;
const cases = JSON.parse(readFileSync(join(here, 'cases.json'), 'utf8')) as Array<{
  case_id: string;
  command: string;
  human_verdict: string;
  human_note: string;
  action: Request['action'];
  evidence_state: Request['evidence_state'];
}>;

let agree = 0;
const disagreements: string[] = [];

for (const c of cases) {
  const request: Request = {
    schema: 'rbk.request.v1',
    request_id: `herdr.${c.case_id}`,
    action: c.action,
    evidence_state: c.evidence_state,
    observed_at: '2026-08-09T10:00:00Z',
  };
  const digests = {
    action_digest: await actionDigest(request.action),
    evidence_state_digest: await evidenceStateDigest(request.evidence_state),
  };
  const decision = decide(policy, request, digests, { computed_at: '2026-08-09T10:00:00Z' });

  const match = decision.outcome === c.human_verdict;
  if (match) agree += 1;
  else disagreements.push(c.case_id);

  const blocking = decision.factors.filter((f) => f.verdict !== 'satisfied' || !f.basis_complete);
  console.log(`\n[${c.case_id}] ${c.command}`);
  console.log(`  human : ${c.human_verdict}  (${c.human_note})`);
  console.log(
    `  kernel: ${decision.outcome}  ${match ? '✔ 一致' : '✘ 不一致'}` +
      `  [basis_complete=${decision.basis_complete}]`,
  );
  for (const f of blocking) {
    const basis = f.basis_complete ? '' : ' +基盤欠損';
    console.log(`    - ${f.factor} = ${f.verdict}${basis}: ${f.reasons.join(' / ')}`);
  }
  if (decision.routing?.required_evidence_modes?.length) {
    console.log(`    → 解決に必要な観測: ${decision.routing.required_evidence_modes.join(', ')}`);
  }
}

console.log(`\n===== ${agree}/${cases.length} で人間の判断と一致 =====`);
if (disagreements.length) console.log(`不一致: ${disagreements.join(', ')}`);
