import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { Subscription, interval, startWith, switchMap } from 'rxjs';
import { CatcamApi, DeviceMetrics } from '../api';

@Component({
  selector: 'app-device-metrics',
  templateUrl: './device-metrics.html',
})
export class DeviceMetricsPanel implements OnInit, OnDestroy {
  private api = inject(CatcamApi);
  private sub?: Subscription;

  protected readonly metrics = signal<DeviceMetrics | null>(null);
  protected readonly error = signal(false);

  protected readonly tempClass = computed(() => {
    const t = this.metrics()?.cpuTemperatureC;
    if (t == null) return 'text-slate-500';
    if (t >= 80) return 'text-red-600';
    if (t >= 70) return 'text-amber-600';
    return 'text-emerald-600';
  });

  protected readonly usageClass = computed(() => {
    const u = this.metrics()?.cpuUsagePercent;
    if (u == null) return 'text-slate-500';
    if (u >= 90) return 'text-red-600';
    if (u >= 70) return 'text-amber-600';
    return 'text-slate-700';
  });

  ngOnInit(): void {
    this.sub = interval(5000)
      .pipe(
        startWith(0),
        switchMap(() => this.api.getMetrics()),
      )
      .subscribe({
        next: m => {
          this.metrics.set(m);
          this.error.set(false);
        },
        error: () => this.error.set(true),
      });
  }

  ngOnDestroy(): void {
    this.sub?.unsubscribe();
  }

  protected formatTemp(c: number | null | undefined): string {
    return c == null ? '—' : `${c.toFixed(1)} °C`;
  }

  protected formatPercent(p: number | null | undefined): string {
    return p == null ? '—' : `${p.toFixed(0)}%`;
  }

  protected formatFreq(mhz: number | null | undefined): string {
    if (mhz == null) return '—';
    return mhz >= 1000 ? `${(mhz / 1000).toFixed(2)} GHz` : `${mhz.toFixed(0)} MHz`;
  }

  protected formatUptime(seconds: number | null | undefined): string {
    if (seconds == null) return '—';
    const s = Math.floor(seconds);
    const days = Math.floor(s / 86400);
    const hours = Math.floor((s % 86400) / 3600);
    const mins = Math.floor((s % 3600) / 60);
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${mins}m`;
    return `${mins}m`;
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

  protected memoryPercent(m: DeviceMetrics['memory']): number | null {
    if (!m || m.totalBytes === 0) return null;
    return (m.usedBytes / m.totalBytes) * 100;
  }

  protected diskPercent(d: DeviceMetrics['disk']): number | null {
    if (!d || d.totalBytes === 0) return null;
    return (d.usedBytes / d.totalBytes) * 100;
  }

  protected formatLoad(load: DeviceMetrics['loadAverage']): string {
    if (!load) return '—';
    return `${load.oneMinute.toFixed(2)} · ${load.fiveMinute.toFixed(2)} · ${load.fifteenMinute.toFixed(2)}`;
  }
}
