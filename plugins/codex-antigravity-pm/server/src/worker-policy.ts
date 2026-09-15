export const DEFAULT_MAX_ATTEMPTS = 1;
export const DEFAULT_TURN_TIMEOUT_MINUTES = 120;

export function maxAttempts(value = process.env.PM_MAX_ATTEMPTS): number {
  const parsed = Number(value ?? DEFAULT_MAX_ATTEMPTS);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 5 ? parsed : DEFAULT_MAX_ATTEMPTS;
}

export function shouldRetry(attempt: number, limit: number): boolean {
  return attempt < limit;
}

export function retryDelaySeconds(attempt: number, baseSeconds: number): number {
  return Math.min(300, Math.max(1, baseSeconds) * 2 ** Math.max(0, attempt - 1));
}

export function turnTimeoutMinutes(value = process.env.PM_TURN_TIMEOUT_MINUTES): number {
  const parsed = Number(value ?? DEFAULT_TURN_TIMEOUT_MINUTES);
  return Number.isInteger(parsed) && parsed >= 10 && parsed <= 480 ? parsed : DEFAULT_TURN_TIMEOUT_MINUTES;
}
