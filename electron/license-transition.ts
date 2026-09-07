import type { LicenseStatus } from './license';

// Keep the recorder mounted until capture has been proved stopped. A failed
// seal remains retryable; it must never become a successful license transition.
export class LicenseTransition {
  private latest: LicenseStatus | null = null;
  private refreshTail: Promise<void> = Promise.resolve();
  private settling = false;
  private revision = 0;
  private deliveryRevision = 0;
  constructor(private readonly evaluate: () => Promise<LicenseStatus>,
    private readonly settleCapture: () => Promise<boolean>,
    private readonly publish: (status: LicenseStatus) => void,
    private readonly isCaptureSettled: () => boolean = () => false) {}

  refresh(): Promise<LicenseStatus> {
    const result = this.refreshTail.then(async () => {
      const evaluated = await this.evaluate();
      if (evaluated.state === 'valid') {
        this.revision++;
        this.update(evaluated);
      } else if (this.isCaptureSettled()) {
        this.update({ ...evaluated, captureStopPending: false });
      } else {
        this.update({ ...evaluated, captureStopPending: true, captureStopError: this.latest?.captureStopError });
        this.trySettle();
      }
      return this.latest!;
    });
    this.refreshTail = result.then(() => undefined, () => undefined);
    return result;
  }

  get pending(): boolean { return this.latest?.captureStopPending === true; }

  private update(status: LicenseStatus): void {
    const changed = JSON.stringify({ ...status, transitionRevision: undefined }) !== JSON.stringify(this.latest && { ...this.latest, transitionRevision: undefined });
    if (changed) {
      this.latest = { ...status, transitionRevision: ++this.deliveryRevision };
      this.publish(this.latest);
    }
  }

  private trySettle(): void {
    if (this.settling) return;
    this.settling = true;
    const revision = this.revision;
    void this.settleCapture().then((sealed) => {
      if (revision === this.revision && this.latest?.state === 'invalid' && sealed) {
        this.update({ ...this.latest, captureStopPending: false, captureStopError: undefined });
      }
    }, (error: unknown) => {
      if (revision === this.revision && this.latest?.state === 'invalid') {
        this.update({ ...this.latest, captureStopPending: true, captureStopError: error instanceof Error ? error.message : String(error) });
      }
    }).finally(() => { this.settling = false; });
  }
}
