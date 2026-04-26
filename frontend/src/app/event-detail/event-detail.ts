import { DatePipe } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { catchError, of, switchMap, timer } from 'rxjs';
import { CatcamApi, EventDetail as EventDetailModel, EventNeighbors, MediaFile } from '../api';

@Component({
  selector: 'app-event-detail',
  imports: [RouterLink, DatePipe],
  templateUrl: './event-detail.html',
})
export class EventDetail {
  private route = inject(ActivatedRoute);
  private api = inject(CatcamApi);

  // Poll every 5s so snapshots and video status refresh while a live event is in progress.
  protected readonly detail = toSignal<EventDetailModel | null>(
    this.route.paramMap.pipe(
      switchMap(p => {
        const id = p.get('id')!;
        return timer(0, 5000).pipe(switchMap(() => this.api.getEvent(id)));
      }),
    ),
    { initialValue: null },
  );

  protected readonly neighbors = toSignal<EventNeighbors | null>(
    this.route.paramMap.pipe(
      switchMap(p => this.api.getNeighbors(p.get('id')!).pipe(catchError(() => of(null)))),
    ),
    { initialValue: null },
  );

  protected readonly streamConfig = toSignal(this.api.getStreamConfig(), { initialValue: null });

  protected readonly lightbox = signal<MediaFile | null>(null);

  protected readonly liveUrl = computed(() => {
    const d = this.detail();
    const config = this.streamConfig();
    if (!d?.summary.inProgress || !config?.url) return null;
    return config.url;
  });

  protected readonly videoUrl = computed(() => {
    const d = this.detail();
    if (!d?.summary.videoFile) return null;
    return this.api.mediaUrl(d.summary.id, d.summary.videoFile);
  });

  protected snapshotUrl(file: MediaFile): string {
    return this.api.mediaUrl(this.detail()!.summary.id, file.name);
  }
}
