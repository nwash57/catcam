import { DatePipe } from '@angular/common';
import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { catchError, of, switchMap, timer } from 'rxjs';
import {
  AnnotatedSubject,
  CatcamApi,
  EventAnnotations,
  EventDetail as EventDetailModel,
  EventNeighbors,
  MediaFile,
  SnapshotAnnotation,
} from '../api';
import { SubjectEditor } from '../annotation/subject-editor';
import { SnapshotAnnotator } from '../annotation/snapshot-annotator';

@Component({
  selector: 'app-event-detail',
  imports: [RouterLink, DatePipe, SubjectEditor, SnapshotAnnotator],
  templateUrl: './event-detail.html',
})
export class EventDetail {
  private route = inject(ActivatedRoute);
  private api = inject(CatcamApi);
  private destroyRef = inject(DestroyRef);

  private currentEventId = signal<string | null>(null);

  protected readonly detail = signal<EventDetailModel | null>(null);
  protected readonly annotations = signal<EventAnnotations>({
    schemaVersion: 1, updatedAt: '', subjects: [], snapshots: [],
  });
  readonly isDirty = signal(false);
  protected readonly isSaving = signal(false);
  protected readonly nameSuggestions = signal<string[]>([]);
  protected readonly activeSnapshot = signal<MediaFile | null>(null);
  protected readonly lightbox = signal<MediaFile | null>(null);

  protected readonly neighbors = toSignal<EventNeighbors | null>(
    this.route.paramMap.pipe(
      switchMap(p => this.api.getNeighbors(p.get('id')!).pipe(catchError(() => of(null)))),
    ),
    { initialValue: null },
  );

  protected readonly streamConfig = toSignal(this.api.getStreamConfig(), { initialValue: null });

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

  constructor() {
    this.route.paramMap.pipe(
      switchMap(p => {
        const id = p.get('id')!;
        this.currentEventId.set(id);
        this.isDirty.set(false);
        this.activeSnapshot.set(null);
        this.annotations.set({ schemaVersion: 1, updatedAt: '', subjects: [], snapshots: [] });

        this.api.getAnnotations(id).pipe(catchError(() => of(null))).subscribe(a => {
          if (a) this.annotations.set(a);
        });

        this.api.getSubjectNames().pipe(catchError(() => of(null))).subscribe(r => {
          if (r) this.nameSuggestions.set(r.names);
        });

        return timer(0, 5000).pipe(switchMap(() => this.api.getEvent(id)));
      }),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe(d => {
      if (!this.isDirty()) {
        this.detail.set(d);
      }
    });
  }

  protected snapshotUrl(file: MediaFile): string {
    return this.api.mediaUrl(this.detail()!.summary.id, file.name);
  }

  protected onSubjectsChange(subjects: AnnotatedSubject[]): void {
    this.annotations.update(a => ({ ...a, subjects }));
    this.isDirty.set(true);
  }

  protected saveAnnotations(): void {
    const id = this.currentEventId();
    if (!id) return;
    this.isSaving.set(true);
    this.api.putAnnotations(id, this.annotations()).pipe(
      takeUntilDestroyed(this.destroyRef),
    ).subscribe({
      next: saved => {
        this.annotations.set(saved);
        this.isDirty.set(false);
        this.isSaving.set(false);
      },
      error: () => this.isSaving.set(false),
    });
  }

  protected openAnnotator(snapshot: MediaFile): void {
    this.activeSnapshot.set(snapshot);
  }

  protected onAnnotatorSave(result: SnapshotAnnotation): void {
    this.annotations.update(a => {
      const existing = a.snapshots.filter(s => s.filename !== result.filename);
      const snapshots = result.annotations.length > 0
        ? [...existing, result]
        : existing;
      return { ...a, snapshots };
    });
    this.isDirty.set(true);
    this.activeSnapshot.set(null);
  }

  protected onAnnotatorCancel(): void {
    this.activeSnapshot.set(null);
  }

  protected snapshotAnnotation(filename: string): SnapshotAnnotation | null {
    return this.annotations().snapshots.find(s => s.filename === filename) ?? null;
  }

  protected hasAnnotation(filename: string): boolean {
    const a = this.snapshotAnnotation(filename);
    return (a?.annotations.length ?? 0) > 0;
  }
}
