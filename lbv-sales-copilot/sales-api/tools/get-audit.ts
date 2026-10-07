import testProspectData from '../data/test-prospect.json' with { type: 'json' };

export async function getAudit() {
  return testProspectData.audit;
}
