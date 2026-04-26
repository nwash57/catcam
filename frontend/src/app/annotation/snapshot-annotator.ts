import { Component, OnInit, computed, input, output, signal } from '@angular/core';
import { AnnotatedSubject, BoundingBox, SnapshotAnnotation, SubjectAnnotation } from '../api';
import { BboxCanvas, DrawnBox } from './bbox-canvas';

const SUBJECT_COLORS = ['#ef4444', '#3b82f6', '#22c55e', '#f59e0b', '#a855f7'];

@Component({
  selector: 'app-snapshot-annotator',
  imports: [BboxCanvas],
  templateUrl: './snapshot-annotator.html',
})
export class SnapshotAnnotator implements OnInit {
  readonly filename = input.required<string>();
  readonly imageUrl = input.required<string>();
  readonly subjects = input.required<AnnotatedSubject[]>();
  readonly existingAnnotation = input<SnapshotAnnotation | null>(null);
  readonly save = output<SnapshotAnnotation>();
  readonly cancel = output<void>();

  protected readonly activeSubjectId = signal<string | null>(null);
  protected readonly rows = signal<SubjectAnnotation[]>([]);

  ngOnInit(): void {
    const existing = this.existingAnnotation();
    const initial = this.subjects().map(subject => {
      const found = existing?.annotations.find(a => a.subjectId === subject.id);
      return found ?? { subjectId: subject.id, includeInTraining: false, boundingBox: null };
    });
    this.rows.set(initial);
  }

  protected colorFor(subjectId: string): string {
    const idx = this.subjects().findIndex(s => s.id === subjectId);
    return SUBJECT_COLORS[idx % SUBJECT_COLORS.length] ?? '#64748b';
  }

  protected labelFor(subjectId: string): string {
    const s = this.subjects().find(s => s.id === subjectId);
    if (!s) return subjectId;
    return s.name ? `${s.name} (${s.species})` : s.species;
  }

  protected appearsInSnapshot(subjectId: string): boolean {
    const row = this.rows().find(r => r.subjectId === subjectId);
    if (!row) return false;
    return row.includeInTraining || row.boundingBox !== null;
  }

  protected setAppears(subjectId: string, appears: boolean): void {
    this.rows.update(rows => rows.map(r =>
      r.subjectId === subjectId
        ? { ...r, includeInTraining: appears, boundingBox: appears ? r.boundingBox : null }
        : r
    ));
    if (!appears && this.activeSubjectId() === subjectId) {
      this.activeSubjectId.set(null);
    }
  }

  protected getIncludeInTraining(subjectId: string): boolean {
    return this.rows().find(r => r.subjectId === subjectId)?.includeInTraining ?? false;
  }

  protected setIncludeInTraining(subjectId: string, value: boolean): void {
    this.rows.update(rows => rows.map(r =>
      r.subjectId === subjectId ? { ...r, includeInTraining: value } : r
    ));
  }

  protected getBbox(subjectId: string): BoundingBox | null {
    return this.rows().find(r => r.subjectId === subjectId)?.boundingBox ?? null;
  }

  protected toggleDrawMode(subjectId: string): void {
    this.activeSubjectId.set(
      this.activeSubjectId() === subjectId ? null : subjectId
    );
  }

  protected clearBbox(subjectId: string): void {
    this.rows.update(rows => rows.map(r =>
      r.subjectId === subjectId ? { ...r, boundingBox: null } : r
    ));
    if (this.activeSubjectId() === subjectId) {
      this.activeSubjectId.set(null);
    }
  }

  protected readonly boxes = computed<DrawnBox[]>(() =>
    this.rows()
      .filter(r => r.boundingBox !== null)
      .map(r => ({ subjectId: r.subjectId, box: r.boundingBox! }))
  );

  protected onBoxDrawn(drawn: DrawnBox): void {
    this.rows.update(rows => rows.map(r =>
      r.subjectId === drawn.subjectId
        ? { ...r, boundingBox: drawn.box, includeInTraining: true }
        : r
    ));
    this.activeSubjectId.set(null);
  }

  protected onSave(): void {
    const annotations = this.rows().filter(r => r.includeInTraining || r.boundingBox !== null);
    this.save.emit({ filename: this.filename(), annotations });
  }

  protected onCancel(): void {
    this.cancel.emit();
  }
}
