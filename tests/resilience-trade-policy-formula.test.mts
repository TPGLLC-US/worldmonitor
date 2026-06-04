// Pin the post-rename `tradePolicy` 3-component weighted-blend formula.
//
// Context. Plan 2026-04-25-004 Phase 1 (Ship 1) renamed the
// `tradeSanctions` dim to `tradePolicy` and DROPPED the OFAC-domicile-
// count component (was weight 0.45). The remaining 3 components were
// reweighted to total 1.0:
//   WTO MFN tariff baseline pressure → 0.30 (was 0.15)
//   WTO agricultural tariff-gap pressure → 0.30 (was 0.15)
//   applied tariff rate    → 0.40 (was 0.25)
//
// The earlier `tests/resilience-sanctions-field-mapping.test.mts`
// (deleted in this PR) pinned `normalizeSanctionCount`'s piecewise
// anchors against scoreTradeSanctions end-to-end. Those assertions
// are obsolete: `normalizeSanctionCount` is retained-but-unused (see
// `_dimension-scorers.ts`), and scoreTradePolicy no longer reads
// `sanctions:country-counts:v1`. This file replaces that pin with a
// formula-shape contract that names each remaining component and the
// weight it MUST carry, so a future numeric drift surfaces here.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  scoreTradePolicy,
  type ResilienceSeedReader,
} from '../server/worldmonitor/resilience/v1/_dimension-scorers.ts';

const TEST_ISO2 = 'XX';

// Helper: a reader that returns the WTO restrictions/barriers payloads
// with an explicit reporter set and no per-country entries (so the
// scorer sees count=0 for any country in the reporter set). Lets us
// drive the WTO components into the "real-data zero" path rather than
// the imputation path, which is what the formula contract needs to
// pin.
function emptyReporterReader(reporterSet: readonly string[]): ResilienceSeedReader {
  return async (key) => {
    if (key === 'trade:restrictions:v1:tariff-overview:50') {
      return { restrictions: [], _reporterCountries: [...reporterSet] };
    }
    if (key === 'trade:barriers:v1:tariff-gap:50') {
      return { barriers: [], _reporterCountries: [...reporterSet] };
    }
    return null;
  };
}

describe('scoreTradePolicy — 3-component weighted-blend formula (Ship 1 contract)', () => {
  it('does NOT read sanctions:country-counts:v1 (OFAC component dropped)', async () => {
    let sanctionsReadCount = 0;
    const reader: ResilienceSeedReader = async (key) => {
      if (key === 'sanctions:country-counts:v1') {
        sanctionsReadCount += 1;
        return { [TEST_ISO2]: 999 }; // would have driven score to 0 under old formula
      }
      return null;
    };
    await scoreTradePolicy(TEST_ISO2, reader);
    assert.equal(
      sanctionsReadCount,
      0,
      'scoreTradePolicy must not call reader(sanctions:country-counts:v1) — OFAC component is dropped',
    );
  });

  it('DOES read every expected component seed key (defends against accidental drops)', async () => {
    // Symmetric counter-positive: if a future refactor accidentally
    // drops one of the 3 remaining components, this test names the
    // missing reader call directly. The static-record key is templated
    // by `readStaticCountry` (resilience:static:{ISO2}); we accept any
    // read that includes that prefix.
    const observed = new Set<string>();
    const reader: ResilienceSeedReader = async (key) => {
      observed.add(key);
      return null;
    };
    await scoreTradePolicy(TEST_ISO2, reader);
    assert.ok(
      observed.has('trade:restrictions:v1:tariff-overview:50'),
      'scoreTradePolicy must call reader(trade:restrictions:v1:tariff-overview:50) — WTO restrictions component (weight 0.30)',
    );
    assert.ok(
      observed.has('trade:barriers:v1:tariff-gap:50'),
      'scoreTradePolicy must call reader(trade:barriers:v1:tariff-gap:50) — WTO barriers component (weight 0.30)',
    );
    assert.ok(
      [...observed].some((k) => k.startsWith('resilience:static:')),
      'scoreTradePolicy must read a resilience:static:{ISO2} key for the applied tariff rate component (weight 0.40)',
    );
  });

  it('reporter-set country with zero restrictions/barriers and no tariff scores 100', async () => {
    // Restrictions = 0 → 100 (lowerBetter at the best anchor).
    // Barriers     = 0 → 100.
    // Tariff       = null (no static record) → contributes null score, drops weight from blend.
    // Blend availableWeight = 0.30 + 0.30 = 0.60. Score = (100*0.30 + 100*0.30) / 0.60 = 100.
    const reader = emptyReporterReader([TEST_ISO2]);
    const result = await scoreTradePolicy(TEST_ISO2, reader);
    assert.equal(result.score, 100, `expected 100 with both WTO components clean and no tariff, got ${result.score}`);
    // Coverage = (1.0*0.30 + 1.0*0.30 + 0*0.40) / 1.0 = 0.60.
    assert.equal(result.coverage, 0.60, `coverage must reflect 0.30+0.30 observed weights / 1.0 total, got ${result.coverage}`);
  });

  it('one-row WTO severity payload separates high, moderate, and low reporters', async () => {
    const reader: ResilienceSeedReader = async (key) => {
      if (key === 'trade:restrictions:v1:tariff-overview:50') {
        return {
          restrictions: [
            { reportingCountry: 'HH', description: 'WTO MFN baseline: 18.1%', status: 'high' },
            { reportingCountry: 'MM', description: 'WTO MFN baseline: 7.5%', status: 'moderate' },
            { reportingCountry: 'LL', description: 'WTO MFN baseline: 1.9%', status: 'low' },
          ],
          _reporterCountries: ['HH', 'MM', 'LL'],
        };
      }
      if (key === 'trade:barriers:v1:tariff-gap:50') {
        return {
          barriers: [
            { notifyingCountry: 'HH', title: 'Agricultural tariff: 36.7% vs Non-agricultural: 13.0% (gap: +23.7pp)', status: 'high' },
            { notifyingCountry: 'MM', title: 'Agricultural tariff: 12.5% vs Non-agricultural: 5.0% (gap: +7.5pp)', status: 'moderate' },
            { notifyingCountry: 'LL', title: 'Agricultural tariff: 5.0% vs Non-agricultural: 3.1% (gap: +1.9pp)', status: 'low' },
          ],
          _reporterCountries: ['HH', 'MM', 'LL'],
        };
      }
      return null;
    };

    const high = await scoreTradePolicy('HH', reader);
    const moderate = await scoreTradePolicy('MM', reader);
    const low = await scoreTradePolicy('LL', reader);

    assert.equal(high.score, 15, `high-pressure one-row payload must not stay near 100, got ${high.score}`);
    assert.equal(moderate.score, 69, `moderate-pressure one-row payload must sit between high and low, got ${moderate.score}`);
    assert.equal(low.score, 93, `low-pressure one-row payload should remain high but distinct, got ${low.score}`);
    assert.ok(high.score < moderate.score && moderate.score < low.score, 'severity ordering must be monotonic');
  });

  it('non-reporter country still gets WTO unmonitored imputation', async () => {
    const reader = emptyReporterReader(['US', 'DE']);
    const result = await scoreTradePolicy('BF', reader);
    assert.equal(result.score, 60, `non-reporter score must remain WTO imputation score, got ${result.score}`);
    assert.equal(result.coverage, 0.24, `non-reporter coverage must retain 0.4 certainty on both WTO slots, got ${result.coverage}`);
    assert.equal(result.observedWeight, 0, `non-reporter WTO slots must not be observed, got ${result.observedWeight}`);
    assert.equal(result.imputedWeight, 0.60, `non-reporter WTO slots must remain imputed weight 0.60, got ${result.imputedWeight}`);
    assert.equal(result.imputationClass, 'unmonitored', `non-reporter class must remain unmonitored, got ${result.imputationClass}`);
  });

  it('weights total exactly 1.0 across the 3 components (full-data path)', async () => {
    // Drive every component into the real-data path via a reader that
    // populates the static-record tariff value AND the WTO arrays
    // anchored at their best values.
    const reader: ResilienceSeedReader = async (key) => {
      if (key === 'trade:restrictions:v1:tariff-overview:50') {
        return { restrictions: [], _reporterCountries: [TEST_ISO2] };
      }
      if (key === 'trade:barriers:v1:tariff-gap:50') {
        return { barriers: [], _reporterCountries: [TEST_ISO2] };
      }
      if (key === `resilience:static:${TEST_ISO2}`) {
        return { appliedTariffRate: { value: 0 } };
      }
      return null;
    };
    const result = await scoreTradePolicy(TEST_ISO2, reader);
    // All 3 components observed at the best anchor → score 100, coverage 1.0.
    assert.equal(result.score, 100, `full-data best-case must yield 100, got ${result.score}`);
    assert.equal(result.coverage, 1.0, `full-data coverage must be exactly 1.0 (0.30+0.30+0.40), got ${result.coverage}`);
  });

  it('full-data worst-case at every anchor scores 0 (formula sanity)', async () => {
    // Restrictions = 30 (legacy IN_FORCE fallback weight 3 each; 10 entries
    //   exceed the 20-best→0-worst tariff-pressure goalpost).
    // Barriers     = 40 legacy plain notifications, exceeding the 30pp
    //   tariff-gap pressure goalpost.
    // Tariff       = 20 → 0 (lowerBetter, worst goalpost).
    // Score = (0*0.30 + 0*0.30 + 0*0.40) / 1.0 = 0.
    const reader: ResilienceSeedReader = async (key) => {
      if (key === 'trade:restrictions:v1:tariff-overview:50') {
        return {
          restrictions: Array.from({ length: 10 }, () => ({
            reportingCountry: TEST_ISO2,
            status: 'IN_FORCE',
          })),
          _reporterCountries: [TEST_ISO2],
        };
      }
      if (key === 'trade:barriers:v1:tariff-gap:50') {
        return {
          barriers: Array.from({ length: 40 }, () => ({
            notifyingCountry: TEST_ISO2,
          })),
          _reporterCountries: [TEST_ISO2],
        };
      }
      if (key === `resilience:static:${TEST_ISO2}`) {
        return { appliedTariffRate: { value: 20 } };
      }
      return null;
    };
    const result = await scoreTradePolicy(TEST_ISO2, reader);
    assert.equal(result.score, 0, `full-data worst-case must yield 0, got ${result.score}`);
    assert.equal(result.coverage, 1.0, `full-data coverage must be exactly 1.0, got ${result.coverage}`);
  });

  it('total seed outage (null reader) produces score=0, coverage=0 (no impute)', async () => {
    const reader: ResilienceSeedReader = async () => null;
    const result = await scoreTradePolicy(TEST_ISO2, reader);
    assert.equal(result.coverage, 0, `total outage must yield coverage=0, got ${result.coverage}`);
    assert.equal(result.score, 0, `total outage must yield score=0 (weightedBlend empty-data shape), got ${result.score}`);
  });
});
