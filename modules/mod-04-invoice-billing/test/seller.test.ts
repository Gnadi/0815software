import { describe, expect, it, vi } from 'vitest';
import { applySeller, startSellerRefresh, type SelfParty } from '../server/seller.js';
import type { SellerConfig } from '../server/config.js';

/** The SELLER_* env values, as configFromEnv would produce them. */
function fromEnv(): SellerConfig {
  return {
    name: 'Env GmbH',
    addressLines: ['Envgasse 1', '1010 Wien'],
    vatId: 'ATU00000000',
    iban: 'AT00 0000 0000 0000 0000',
    bic: 'ENVXX',
  };
}

const fullSelf: SelfParty = {
  name: 'Platform GmbH',
  vat_id: 'ATU99999999',
  address_lines: ['Plattformweg 9', '4020 Linz', 'Austria'],
  iban: 'AT99 9999 9999 9999 9999',
  bic: 'PLATXX',
};

describe('seller letterhead precedence', () => {
  it("uses PS-11's self party when it has one", async () => {
    const seller = fromEnv();
    expect(await applySeller(seller, async () => fullSelf)).toBe(true);
    expect(seller).toEqual({
      name: 'Platform GmbH',
      addressLines: ['Plattformweg 9', '4020 Linz', 'Austria'],
      vatId: 'ATU99999999',
      iban: 'AT99 9999 9999 9999 9999',
      bic: 'PLATXX',
    });
  });

  it('keeps the env when PS-11 is not configured (returns null)', async () => {
    const seller = fromEnv();
    expect(await applySeller(seller, async () => null)).toBe(false);
    expect(seller).toEqual(fromEnv());
  });

  it('keeps the env when PS-11 is unreachable — a lookup never breaks a boot', async () => {
    const seller = fromEnv();
    expect(
      await applySeller(seller, async () => {
        throw new Error('ECONNREFUSED');
      }),
    ).toBe(false);
    expect(seller).toEqual(fromEnv());
  });

  it('falls back per field, so a half-filled party cannot blank a letterhead', async () => {
    const seller = fromEnv();
    await applySeller(seller, async () => ({
      name: 'Platform GmbH',
      vat_id: null,
      address_lines: [],
      iban: null,
      bic: null,
    }));
    expect(seller.name).toBe('Platform GmbH');
    // Everything the party left empty still comes from the env.
    expect(seller.vatId).toBe('ATU00000000');
    expect(seller.addressLines).toEqual(['Envgasse 1', '1010 Wien']);
    expect(seller.iban).toBe('AT00 0000 0000 0000 0000');
    expect(seller.bic).toBe('ENVXX');
  });

  it('ignores a whitespace-only platform name', async () => {
    const seller = fromEnv();
    await applySeller(seller, async () => ({ ...fullSelf, name: '   ' }));
    expect(seller.name).toBe('Env GmbH');
  });

  it('mutates in place, because the PDF renderer holds this object', async () => {
    const seller = fromEnv();
    const captured = seller; // what createApp would have captured
    await applySeller(seller, async () => fullSelf);
    expect(captured.name).toBe('Platform GmbH');
  });
});

describe('seller refresh', () => {
  it('re-reads on the interval so a change needs no restart', async () => {
    vi.useFakeTimers();
    try {
      const seller = fromEnv();
      let current: SelfParty = { ...fullSelf, name: 'First GmbH' };
      const stop = startSellerRefresh(seller, async () => current, 1000);

      await vi.advanceTimersByTimeAsync(1000);
      expect(seller.name).toBe('First GmbH');

      current = { ...fullSelf, name: 'Renamed GmbH' };
      await vi.advanceTimersByTimeAsync(1000);
      expect(seller.name).toBe('Renamed GmbH');

      stop();
      current = { ...fullSelf, name: 'Too Late GmbH' };
      await vi.advanceTimersByTimeAsync(5000);
      expect(seller.name).toBe('Renamed GmbH');
    } finally {
      vi.useRealTimers();
    }
  });
});
