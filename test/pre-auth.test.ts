import { isAccountLocked } from '../lambda/pre-auth/index';

describe('Pre-Authentication Lockout Logic', () => {
  const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes in ms

  describe('isAccountLocked', () => {
    it('should not lock account with fewer than 5 failed attempts', () => {
      const now = Date.now();
      const lastFailedAt = new Date(now - 60_000).toISOString(); // 1 min ago

      for (let attempts = 0; attempts < 5; attempts++) {
        const result = isAccountLocked(attempts, lastFailedAt, now);
        expect(result.locked).toBe(false);
      }
    });

    it('should lock account with exactly 5 failed attempts within 15 minutes', () => {
      const now = Date.now();
      const lastFailedAt = new Date(now - 5 * 60_000).toISOString(); // 5 min ago

      const result = isAccountLocked(5, lastFailedAt, now);
      expect(result.locked).toBe(true);
      expect(result.elapsedMinutes).toBeCloseTo(5, 0);
    });

    it('should lock account with more than 5 failed attempts within 15 minutes', () => {
      const now = Date.now();
      const lastFailedAt = new Date(now - 10 * 60_000).toISOString(); // 10 min ago

      const result = isAccountLocked(8, lastFailedAt, now);
      expect(result.locked).toBe(true);
      expect(result.elapsedMinutes).toBeCloseTo(10, 0);
    });

    it('should NOT lock account when lockout period has elapsed (>= 15 min)', () => {
      const now = Date.now();
      const lastFailedAt = new Date(now - LOCKOUT_DURATION_MS).toISOString(); // exactly 15 min ago

      const result = isAccountLocked(5, lastFailedAt, now);
      expect(result.locked).toBe(false);
    });

    it('should NOT lock account when lockout period has well elapsed (> 15 min)', () => {
      const now = Date.now();
      const lastFailedAt = new Date(now - 30 * 60_000).toISOString(); // 30 min ago

      const result = isAccountLocked(10, lastFailedAt, now);
      expect(result.locked).toBe(false);
      expect(result.elapsedMinutes).toBeCloseTo(30, 0);
    });

    it('should not lock when lastFailedAt is undefined', () => {
      const now = Date.now();
      const result = isAccountLocked(5, undefined, now);
      expect(result.locked).toBe(false);
    });

    it('should not lock when failedAttempts is 0', () => {
      const now = Date.now();
      const result = isAccountLocked(0, new Date(now - 1000).toISOString(), now);
      expect(result.locked).toBe(false);
    });

    it('should lock when exactly at the boundary (14.9 minutes elapsed)', () => {
      const now = Date.now();
      const lastFailedAt = new Date(now - 14.9 * 60_000).toISOString(); // 14.9 min ago

      const result = isAccountLocked(5, lastFailedAt, now);
      expect(result.locked).toBe(true);
    });

    it('should NOT lock at exactly 15 minutes (boundary)', () => {
      const now = Date.now();
      const lastFailedAt = new Date(now - 15 * 60_000).toISOString(); // exactly 15 min

      const result = isAccountLocked(5, lastFailedAt, now);
      expect(result.locked).toBe(false);
    });
  });
});
