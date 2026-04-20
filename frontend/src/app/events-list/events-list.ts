import { DatePipe } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { CatcamApi, EventSummary } from '../api';

@Component({
  selector: 'app-events-list',
  imports: [RouterLink, DatePipe],
  templateUrl: './events-list.html',
})
export class EventsList {
  private api = inject(CatcamApi);

  protected readonly events = toSignal(this.api.listEvents(), { initialValue: [] as EventSummary[] });
  protected readonly query = signal('');
  protected readonly sortNewest = signal(true);

  protected readonly filtered = computed(() => {
    const q = this.query().toLowerCase().trim();
    const list = this.events().filter(
      e => !q || e.species.some(s => s.toLowerCase().includes(q)) || e.id.toLowerCase().includes(q),
    );
    const sorted = [...list].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    return this.sortNewest() ? sorted.reverse() : sorted;
  });

  protected triggerUrl(e: EventSummary): string | null {
    return e.triggerFile ? this.api.mediaUrl(e.id, e.triggerFile) : null;
  }

  protected duration(e: EventSummary): string {
    if (!e.endedAt) return 'in progress';
    const ms = new Date(e.endedAt).getTime() - new Date(e.startedAt).getTime();
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const rs = s % 60;
    return `${m}m ${rs}s`;
  }

  protected onQueryInput(event: Event) {
    this.query.set((event.target as HTMLInputElement).value);
  }
}
