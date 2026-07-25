import { BaseClient } from './http.js';

export interface NextNumber {
  scope: string;
  value: number;
  period_key: string;
  formatted: string;
}

export interface SequenceConfig {
  scope: string;
  format: string;
  period: 'none' | 'year' | 'month' | 'day';
  created_at: string;
}

/** Client for PS-10 Number (default port 4010). */
export class NumberClient extends BaseClient {
  /** Allocate the next gapless number for a scope. */
  next(scope: string): Promise<NextNumber> {
    return this.apiPost<NextNumber>('/api/next', { scope });
  }

  /** Configure a scope's format and period. */
  configure(scope: string, format: string, period: SequenceConfig['period'] = 'none'): Promise<SequenceConfig> {
    return this.apiPost<SequenceConfig>('/api/sequences', { scope, format, period });
  }

  get(scope: string): Promise<{ config: SequenceConfig | null; current: { scope: string; last_value: number; period_key: string } }> {
    return this.apiGet(`/api/sequences/${encodeURIComponent(scope)}`);
  }
}
