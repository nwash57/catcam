import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { EMPTY, Subscription, catchError, interval, startWith, switchMap } from 'rxjs';
import { CatcamApi, HealthReport } from '../api';

/**
 * Always-visible health indicator in the header.
 *
 * Deliberately small when everything is fine and impossible to miss when it is
 * not — the whole point is that a degraded system should be obvious from any
 * page, not only from a dashboard someone remembers to open.
 */
@Component({
  selector: 'app-health-pill',
  imports: [RouterLink],
  templateUrl: './health-pill.html',
})
export class HealthPill implements OnInit, OnDestroy {
  private api = inject(CatcamApi);
  private sub?: Subscription;

  protected readonly report = signal<HealthReport | null>(null);
  protected readonly unreachable = signal(false);

  protected readonly failing = computed(
    () => this.report()?.checks.filter(c => c.status !== 'ok') ?? [],
  );

  protected readonly label = computed(() => {
    if (this.unreachable()) return 'API unreachable';
    const status = this.report()?.status;
    if (status === 'fail') return `${this.failing().length} problem${this.failing().length === 1 ? '' : 's'}`;
    if (status === 'warn') return 'Needs a look';
    return status === 'ok' ? 'Healthy' : 'Checking…';
  });

  protected readonly pillClass = computed(() => {
    if (this.unreachable()) return 'bg-slate-100 text-slate-600 ring-slate-300';
    switch (this.report()?.status) {
      case 'fail':
        return 'bg-red-50 text-red-700 ring-red-300';
      case 'warn':
        return 'bg-amber-50 text-amber-800 ring-amber-300';
      case 'ok':
        return 'bg-emerald-50 text-emerald-700 ring-emerald-300';
      default:
        return 'bg-slate-100 text-slate-500 ring-slate-200';
    }
  });

  protected readonly dotClass = computed(() => {
    if (this.unreachable()) return 'bg-slate-400';
    switch (this.report()?.status) {
      case 'fail':
        return 'bg-red-500';
      case 'warn':
        return 'bg-amber-500';
      case 'ok':
        return 'bg-emerald-500';
      default:
        return 'bg-slate-300';
    }
  });

  ngOnInit(): void {
    // catchError sits inside switchMap on purpose: handling the error in
    // subscribe() would tear down the interval, so one failed poll would leave
    // the pill frozen on a stale verdict for the life of the page.
    this.sub = interval(30000)
      .pipe(
        startWith(0),
        switchMap(() =>
          this.api.getHealth().pipe(
            catchError(() => {
              this.unreachable.set(true);
              return EMPTY;
            }),
          ),
        ),
      )
      .subscribe(r => {
        this.report.set(r);
        this.unreachable.set(false);
      });
  }

  ngOnDestroy(): void {
    this.sub?.unsubscribe();
  }
}
