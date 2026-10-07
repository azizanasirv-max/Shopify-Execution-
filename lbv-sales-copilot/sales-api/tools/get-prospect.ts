import testProspectData from '../data/test-prospect.json' with { type: 'json' };

export async function getProspect() {
  return testProspectData.prospect;
}
