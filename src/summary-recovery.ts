export class CompactionTransientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompactionTransientError";
  }
}

// Pi 0.85.1 fixes RPC abort propagation to the compaction controller.
// Unknown/prerelease versions are not evidence that cancellation is safe.
export function supportsCompactionRecovery(version: string): boolean {
  if (!/^\d+\.\d+\.\d+$/.test(version)) return false;
  const [major, minor, patch] = version.split(".").map(Number);
  return major > 0 || minor > 85 || (minor === 85 && patch >= 1);
}

export function waitForCompactionRecovery(signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(false);
    const finish = (ready: boolean) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      resolve(ready);
    };
    const abort = () => finish(false);
    // Avoid synchronized retries across the fleet; never hammer a failed route.
    const timer = setTimeout(() => finish(true), 30_000 + Math.random() * 30_000);
    signal.addEventListener("abort", abort, { once: true });
  });
}
