import { describe, it, expect } from 'vitest';

describe('Utility Functions', () => {
  describe('formatBytes', () => {
    it('formats bytes correctly', () => {
      const formatBytes = (bytes: number): string => {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
      };

      expect(formatBytes(0)).toBe('0 B');
      expect(formatBytes(512)).toBe('512 B');
      expect(formatBytes(1024)).toBe('1 KB');
      expect(formatBytes(1536)).toBe('1.5 KB');
      expect(formatBytes(1048576)).toBe('1 MB');
      expect(formatBytes(1073741824)).toBe('1 GB');
    });
  });

  describe('formatDuration', () => {
    it('formats duration correctly', () => {
      const formatDuration = (ms: number | null): string => {
        if (ms === null) return '—';
        if (ms < 1000) return `${ms.toFixed(0)}ms`;
        return `${(ms / 1000).toFixed(2)}s`;
      };

      expect(formatDuration(null)).toBe('—');
      expect(formatDuration(150)).toBe('150ms');
      expect(formatDuration(1500)).toBe('1.50s');
      expect(formatDuration(0)).toBe('0ms');
    });
  });

  describe('formatTimestamp', () => {
    it('formats timestamp correctly', () => {
      const formatTimestamp = (timestamp: string, timezone?: string): string => {
        const date = new Date(timestamp);
        return date.toLocaleString(undefined, {
          month: 'short',
          day: '2-digit',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit',
          hour12: false,
          timeZone: timezone,
        });
      };

      const result = formatTimestamp('2024-01-15T10:30:00Z', 'UTC');
      expect(result).toContain('Jan');
      expect(result).toContain('15');
      expect(result).toContain('2024');
    });
  });
});

describe('Authentication State', () => {
  it('localStorage getItem returns null when not set', () => {
    localStorage.clear();
    expect(localStorage.getItem('authToken')).toBeNull();
  });

  it('localStorage can store and retrieve auth token', () => {
    const token = 'test-token-123';
    localStorage.setItem('authToken', token);
    expect(localStorage.getItem('authToken')).toBe(token);
    localStorage.removeItem('authToken');
  });
});
