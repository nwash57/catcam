import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { EMPTY, Observable, Subscription, catchError, interval, startWith, switchMap, tap } from 'rxjs';
import { CatcamApi, DeviceMetrics, HealthCheck, HealthReport, LogPage } from '../api';

/**
 * Everything needed to answer "is the camera actually working, and if not why".
 *
 * Health checks first because they carry the verdict; raw metrics and the log
 * tail below for when the verdict isn't enough to explain itself.
 */
@Component({
  selector: 'app-diagnostics',
  templateUrl: './diagnostics.html',
})
export class Diagnostics implements OnInit, OnDestroy {
  private api = inject(CatcamApi);
  private subs: Subscription[] = [];

  protected readonly health = signal<HealthReport | null>(null);
  protected readonly metrics = signal<DeviceMetrics | null>(null);
  protected readonly logs = signal<LogPage | null>(null);
  protected readonly healthError = signal(false);

  /** First response has landed — until then the page shows skeletons, not blanks. */
  protected readonly healthLoaded = signal(false);
  protected readonly metricsLoaded = signal(false);
  protected readonly logsLoaded = signal(false);

  /** A request is in flight. Drives the subtle "refreshing" hint in the header. */
  protected readonly healthBusy = signal(false);

  protected readonly problems = computed(
    () => this.health()?.checks.filter(c => c.status !== 'ok') ?? [],
  );
  protected readonly passing = computed(
    () => this.health()?.checks.filter(c => c.status === 'ok') ?? [],
  );

  protected readonly captures = computed(() => this.metrics()?.captures ?? null);

  ngOnInit(): void {
    this.subs.push(
      this.poll(15000, () => this.api.getHealth(), {
        before: () => this.healthBusy.set(true),
        next: r => {
          this.health.set(r);
          this.healthError.set(false);
        },
        error: () => this.healthError.set(true),
        settled: () => {
          this.healthBusy.set(false);
          this.healthLoaded.set(true);
        },
      }),
      this.poll(10000, () => this.api.getMetrics(), {
        next: m => this.metrics.set(m),
        error: () => this.metrics.set(null),
        settled: () => this.metricsLoaded.set(true),
      }),
      this.poll(10000, () => this.api.getLogs(200), {
        next: l => this.logs.set(l),
        error: () => this.logs.set(null),
        settled: () => this.logsLoaded.set(true),
      }),
    );
  }

  ngOnDestroy(): void {
    this.subs.forEach(s => s.unsubscribe());
  }

  /**
   * Poll `fetch` on an interval, surviving failures.
   *
   * The obvious version — subscribe({ error }) — looks like it handles errors
   * but doesn't: an error terminates the outer interval too, so one failed
   * request silently ends all future polling and the page sits on stale data.
   * Catching inside switchMap keeps the timer alive.
   */
  private poll<T>(
    periodMs: number,
    fetch: () => Observable<T>,
    handlers: {
      before?: () => void;
      next: (value: T) => void;
      error: () => void;
      settled?: () => void;
    },
  ): Subscription {
    return interval(periodMs)
      .pipe(
        startWith(0),
        tap(() => handlers.before?.()),
        switchMap(() =>
          fetch().pipe(
            catchError(() => {
              handlers.error();
              handlers.settled?.();
              return EMPTY;
            }),
          ),
        ),
      )
      .subscribe(value => {
        handlers.next(value);
        handlers.settled?.();
      });
  }

  protected statusRowClass(check: HealthCheck): string {
    switch (check.status) {
      case 'fail':
        return 'border-red-200 bg-red-50';
      case 'warn':
        return 'border-amber-200 bg-amber-50';
      default:
        return 'border-slate-200 bg-white';
    }
  }

  protected statusBadgeClass(check: HealthCheck): string {
    switch (check.status) {
      case 'fail':
        return 'bg-red-100 text-red-700';
      case 'warn':
        return 'bg-amber-100 text-amber-800';
      default:
        return 'bg-emerald-100 text-emerald-700';
    }
  }

  protected levelClass(level: string | null): string {
    switch (level) {
      case 'error':
        return 'text-red-600';
      case 'warn':
        return 'text-amber-600';
      default:
        return 'text-slate-500';
    }
  }

  protected formatBytes(bytes: number | null | undefined): string {
    if (bytes == null) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let v = bytes;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i++;
    }
    return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
  }

  protected formatTime(value: string | null | undefined): string {
    if (!value) return '—';
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString();
  }

  protected formatClock(value: string | null | undefined): string {
    if (!value) return '';
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString();
  }
}
