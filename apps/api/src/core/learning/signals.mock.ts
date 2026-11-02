/**
 * Mock signals seam (Person 3 merge queue, Person 4 variant picker → Person 2): an
 * in-memory signal log. Validates each signal against the contract and appends it.
 */

import { preferenceSignalSchema, type PreferenceSignal, type SignalSeam } from '@htn/shared';

export class InMemorySignalLog implements SignalSeam {
  private readonly signals: PreferenceSignal[] = [];

  async recordSignal(s: PreferenceSignal): Promise<void> {
    this.signals.push(preferenceSignalSchema.parse(s));
  }

  list(): PreferenceSignal[] {
    return [...this.signals];
  }

  clear(): void {
    this.signals.length = 0;
  }
}
