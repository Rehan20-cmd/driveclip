/**
 * Formats seconds into MM:SS (or HH:MM:SS if >= 3600s or forceHours is true)
 * Examples:
 *  1200 -> "20:00" (or "00:20:00" when forceHours=true)
 *  1800 -> "30:00"
 *  120  -> "02:00"
 */
export function formatTimeDisplay(totalSeconds: number, forceHours = false): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) {
    return forceHours ? '00:00:00' : '00:00';
  }
  const rounded = Math.floor(totalSeconds);
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const seconds = rounded % 60;

  if (forceHours || hours > 0) {
    const totalMinutesForDisplay = forceHours ? minutes : minutes;
    if (!forceHours && hours > 0 && rounded <= 3600) {
      // e.g. exactly 30:00 or 60:00
      const minsTotal = Math.floor(rounded / 60);
      return `${String(minsTotal).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    }
    return `${String(hours).padStart(2, '0')}:${String(totalMinutesForDisplay).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/**
 * Formats seconds strictly as HH:MM:SS (e.g. 00:20:00) for manual timestamp inputs
 */
export function formatTimeHMS(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '00:00:00';
  const rounded = Math.floor(totalSeconds);
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const seconds = rounded % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/**
 * Parses a user-entered timestamp string ("HH:MM:SS", "MM:SS", or "SS") into total seconds.
 * Returns null if invalid.
 */
export function parseTimeInput(raw: string): number | null {
  const cleaned = raw.trim();
  if (!cleaned) return null;

  const parts = cleaned.split(':');
  if (parts.length > 3) return null;

  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => isNaN(n) || n < 0)) return null;

  if (nums.length === 3) {
    const [h, m, s] = nums;
    if (m >= 60 || s >= 60) return null;
    return h * 3600 + m * 60 + s;
  }

  if (nums.length === 2) {
    const [m, s] = nums;
    if (s >= 60) return null;
    return m * 60 + s;
  }

  return nums[0];
}

/**
 * Formats bytes into human-readable string (e.g., "~25 MB", "1.85 GB")
 */
export function formatBytes(bytes: number, prefixApprox = false): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return 'Unknown';
  const prefix = prefixApprox ? '~' : '';

  const mb = bytes / (1000 * 1000);
  if (mb >= 1000) {
    return `${prefix}${(mb / 1000).toFixed(2)} GB`;
  }
  if (mb >= 10) {
    return `${prefix}${Math.round(mb)} MB`;
  }
  if (mb >= 1) {
    return `${prefix}${mb.toFixed(1)} MB`;
  }
  const kb = Math.max(1, Math.round(bytes / 1000));
  return `${prefix}${kb} KB`;
}
