import { describe, it, expect } from 'vitest';
import { buildHumanSummary } from './triage';

describe('buildHumanSummary', () => {
  it('mentions error groups, app versions, and bug count', () => {
    const summary = buildHumanSummary({
      open_groups: 3,
      affected_users: 12,
      regressed: 1,
      untriaged_bugs: 4,
      top_endpoint: '/trips/get',
      top_app_version: '2.0.23',
    });
    expect(summary).toContain('3');
    expect(summary).toContain('12');
    expect(summary).toContain('/trips/get');
    expect(summary).toContain('2.0.23');
    expect(summary).toContain('4');
  });

  it('handles zero state gracefully', () => {
    const summary = buildHumanSummary({
      open_groups: 0, affected_users: 0, regressed: 0,
      untriaged_bugs: 0, top_endpoint: null, top_app_version: null,
    });
    expect(summary.toLowerCase()).toContain('no');
  });
});
