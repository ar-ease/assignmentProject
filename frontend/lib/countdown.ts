export function createCountdown(now: () => number = () => performance.now()) {
  let deadline = 0;
  return {
    sync(expiresInSeconds: number) {
      deadline = now() + expiresInSeconds * 1000;
    },
    remaining() {
      return Math.max(0, Math.ceil((deadline - now()) / 1000));
    },
  };
}

export function formatCountdown(seconds: number): string {
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}
