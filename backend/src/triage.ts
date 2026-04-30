/**
 * Triage summary helpers. Pure templating — no LLM calls — so the daily
 * digest stays free, deterministic, and testable.
 */

export interface SummaryInput {
  open_groups: number;
  affected_users: number;
  regressed: number;
  untriaged_bugs: number;
  top_endpoint: string | null;
  top_app_version: string | null;
}

export function buildHumanSummary(s: SummaryInput): string {
  if (s.open_groups === 0 && s.untriaged_bugs === 0 && s.regressed === 0) {
    return 'No open issues — everything looks calm right now.';
  }
  const parts: string[] = [];
  if (s.regressed > 0) {
    parts.push(`${s.regressed} new error group${s.regressed === 1 ? '' : 's'} since yesterday`);
  }
  if (s.open_groups > 0) {
    parts.push(`${s.open_groups} open error group${s.open_groups === 1 ? '' : 's'}`);
  }
  if (s.affected_users > 0) {
    parts.push(`${s.affected_users} user${s.affected_users === 1 ? '' : 's'} affected`);
  }
  if (s.top_endpoint) {
    parts.push(`top endpoint: ${s.top_endpoint}`);
  }
  if (s.top_app_version) {
    parts.push(`active build: ${s.top_app_version}`);
  }
  if (s.untriaged_bugs > 0) {
    parts.push(`${s.untriaged_bugs} bug report${s.untriaged_bugs === 1 ? '' : 's'} untriaged`);
  }
  return parts.join(' · ') + '.';
}
