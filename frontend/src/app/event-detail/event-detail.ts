import { DatePipe } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { switchMap } from 'rxjs';
import { CatcamApi, EventDetail as EventDetailModel, MediaFile } from '../api';

@Component({
  selector: 'app-event-detail',
  imports: [RouterLink, DatePipe],
  templateUrl: './event-detail.html',
})
export class EventDetail {
  private route = inject(ActivatedRoute);
  private api = inject(CatcamApi);

  protected readonly detail = toSignal<EventDetailModel | null>(
    this.route.paramMap.pipe(switchMap(p => this.api.getEvent(p.get('id')!))),
    { initialValue: null },
  );

  protected readonly lightbox = signal<MediaFile | null>(null);

  protected readonly videoUrl = computed(() => {
    const d = this.detail();
    if (!d?.summary.videoFile) return null;
    return this.api.mediaUrl(d.summary.id, d.summary.videoFile);
  });

  protected snapshotUrl(file: MediaFile): string {
    return this.api.mediaUrl(this.detail()!.summary.id, file.name);
  }
}
