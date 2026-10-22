import { describe, expect, it, vi } from 'vitest';
import { buildPlatform } from '../server/platform.js';
import { refreshSellerSource, startSellerSourceRefresh, type SelfParty } from '../server/seller.js';
import { SellerSource } from '../server/seller-settings.js';
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

/** A live seller object and the sources that feed it, PS-11 wired. */
function wired(): { seller: SellerConfig; source: SellerSource } {
  const seller = fromEnv();
  return { seller, source: new SellerSource(seller, true) };
}

describe('seller letterhead precedence', () => {
  it("uses PS-11's self party when it has one", async () => {
    const { seller, source } = wired();
    expect(await refreshSellerSource(source, async () => fullSelf)).toBe(true);
    expect(seller).toMatchObject({
      name: 'Platform GmbH',
      addressLines: ['Plattformweg 9', '4020 Linz', 'Austria'],
      vatId: 'ATU99999999',
      iban: 'AT99 9999 9999 9999 9999',
      bic: 'PLATXX',
    });
  });

  it('keeps the env when PS-11 has no self party (returns null)', async () => {
    const { seller, source } = wired();
    expect(await refreshSellerSource(source, async () => null)).toBe(false);
    expect(seller).toMatchObject(fromEnv());
  });

  it('keeps the env when PS-11 is unreachable at boot — a lookup never breaks a boot', async () => {
    const { seller, source } = wired();
    expect(
      await refreshSellerSource(source, async () => {
        throw new Error('ECONNREFUSED');
      }),
    ).toBe(false);
    expect(seller).toMatchObject(fromEnv());
  });

  it('keeps the LAST PS-11 party through an outage — the env placeholders never return', async () => {
    const { seller, source } = wired();
    await refreshSellerSource(source, async () => fullSelf);
    // The real client against a port nobody listens on: what an outage looks like.
    const down = buildPlatform({ customersUrl: 'http://127.0.0.1:9', serviceToken: 't' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await refreshSellerSource(source, () => down.fetchSelf())).toBe(false);
    } finally {
      warn.mockRestore();
    }
    expect(seller).toMatchObject({ name: 'Platform GmbH', vatId: 'ATU99999999', iban: 'AT99 9999 9999 9999 9999' });
  });

  it('falls back per field, so a half-filled party cannot blank a letterhead', async () => {
    const { seller, source } = wired();
    await refreshSellerSource(source, async () => ({
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

  it('trims what PS-11 sends, and ignores a whitespace-only name', async () => {
    const { seller, source } = wired();
    await refreshSellerSource(source, async () => ({ ...fullSelf, name: ' Acme GmbH ', vat_id: ' ATU99999999 ', address_lines: [' Weg 1 ', ' '] }));
    expect(seller).toMatchObject({ name: 'Acme GmbH', vatId: 'ATU99999999', addressLines: ['Weg 1'] });
    await refreshSellerSource(source, async () => ({ ...fullSelf, name: '   ' }));
    expect(seller.name).toBe('Env GmbH');
  });

  it('mutates in place, because the PDF renderer holds this object', async () => {
    const { seller, source } = wired();
    const captured = seller; // what createApp would have captured
    await refreshSellerSource(source, async () => fullSelf);
    expect(captured.name).toBe('Platform GmbH');
  });
});

describe('seller refresh', () => {
  it('re-reads on the interval so a change needs no restart', async () => {
    vi.useFakeTimers();
    try {
      const { seller, source } = wired();
      let current: SelfParty = { ...fullSelf, name: 'First GmbH' };
      const stop = startSellerSourceRefresh(source, async () => current, 1000);

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
