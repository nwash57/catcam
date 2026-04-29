import { DatePipe } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { EMPTY, catchError, map, switchMap, tap } from 'rxjs';
import { ALLOWED_SPECIES, CatcamApi, EventPage, EventSummary, Species } from '../api';

const PAGE_SIZE = 48;

@Component({
  selector: 'app-events-list',
  imports: [RouterLink, DatePipe],
  templateUrl: './events-list.html',
})
export class EventsList {
  private api = inject(CatcamApi);

  protected readonly allowedSpecies = ALLOWED_SPECIES;
  protected readonly pageSize = PAGE_SIZE;
  protected readonly skip = signal(0);
  protected readonly query = signal('');
  protected readonly sortNewest = signal(true);
  protected readonly speciesFilter = signal('');
  protected readonly nameFilter = signal('');
  protected readonly loading = signal(false);
  protected readonly error = signal(false);

  protected readonly availableNames = toSignal(
    toObservable(this.speciesFilter).pipe(
      switchMap(species =>
        this.api.getSubjectNames(species ? species as Species : undefined).pipe(
          map(r => r.names),
        ),
      ),
    ),
    { initialValue: [] as string[] },
  );

  private readonly fetchParams = computed(() => ({
    skip: this.skip(),
    species: this.speciesFilter(),
    name: this.nameFilter(),
  }));

  private readonly page = toSignal(
    toObservable(this.fetchParams).pipe(
      tap(() => {
        this.loading.set(true);
        this.error.set(false);
      }),
      switchMap(({ skip, species, name }) =>
        this.api.listEvents(skip, PAGE_SIZE, species || undefined, name || undefined).pipe(
          catchError(() => {
            this.loading.set(false);
            this.error.set(true);
            return EMPTY;
          }),
        ),
      ),
      tap(() => this.loading.set(false)),
    ),
    { initialValue: { items: [], total: 0 } as EventPage },
  );

  protected readonly items = computed(() => this.page().items);
  protected readonly total = computed(() => this.page().total);

  protected readonly filtered = computed(() => {
    const q = this.query().toLowerCase().trim();
    const list = this.items().filter(
      e => !q || e.species.some(s => s.toLowerCase().includes(q)) || e.id.toLowerCase().includes(q),
    );
    const sorted = [...list].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    return this.sortNewest() ? sorted.reverse() : sorted;
  });

  protected readonly rangeStart = computed(() =>
    this.total() === 0 ? 0 : this.skip() + 1,
  );
  protected readonly rangeEnd = computed(() =>
    Math.min(this.skip() + this.items().length, this.total()),
  );
  protected readonly hasPrev = computed(() => this.skip() > 0);
  protected readonly hasNext = computed(() => this.skip() + PAGE_SIZE < this.total());

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

  protected onSpeciesChange(event: Event) {
    this.speciesFilter.set((event.target as HTMLSelectElement).value);
    this.nameFilter.set('');
    this.skip.set(0);
  }

  protected onNameChange(event: Event) {
    this.nameFilter.set((event.target as HTMLSelectElement).value);
    this.skip.set(0);
  }

  protected prev() {
    this.skip.set(Math.max(0, this.skip() - PAGE_SIZE));
  }

  protected next() {
    if (this.hasNext()) this.skip.set(this.skip() + PAGE_SIZE);
  }
}
