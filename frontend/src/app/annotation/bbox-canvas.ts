import {
  AfterViewInit,
  Component,
  ElementRef,
  ViewChild,
  effect,
  input,
  output,
} from '@angular/core';
import { AnnotatedSubject, BoundingBox } from '../api';

export interface DrawnBox {
  subjectId: string;
  box: BoundingBox;
}

const SUBJECT_COLORS = ['#ef4444', '#3b82f6', '#22c55e', '#f59e0b', '#a855f7'];

@Component({
  selector: 'app-bbox-canvas',
  templateUrl: './bbox-canvas.html',
})
export class BboxCanvas implements AfterViewInit {
  readonly imageUrl = input.required<string>();
  readonly subjects = input.required<AnnotatedSubject[]>();
  readonly boxes = input<DrawnBox[]>([]);
  readonly activeSubjectId = input<string | null>(null);
  readonly boxDrawn = output<DrawnBox>();

  @ViewChild('canvas') private canvasRef!: ElementRef<HTMLCanvasElement>;
  @ViewChild('img') private imgRef!: ElementRef<HTMLImageElement>;

  private dragStart: { x: number; y: number } | null = null;
  private dragCurrent: { x: number; y: number } | null = null;

  constructor() {
    // Redraw whenever boxes or activeSubjectId signal changes
    effect(() => {
      this.boxes();
      this.activeSubjectId();
      this.redraw();
    });
  }

  ngAfterViewInit(): void {
    this.redraw();
  }

  protected colorFor(subjectId: string): string {
    const idx = this.subjects().findIndex(s => s.id === subjectId);
    return SUBJECT_COLORS[idx % SUBJECT_COLORS.length] ?? '#64748b';
  }

  protected onMouseDown(event: MouseEvent): void {
    if (!this.activeSubjectId()) return;
    const rect = this.canvasRef.nativeElement.getBoundingClientRect();
    this.dragStart = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    this.dragCurrent = { ...this.dragStart };
    event.preventDefault();
  }

  protected onMouseMove(event: MouseEvent): void {
    if (!this.dragStart) return;
    const rect = this.canvasRef.nativeElement.getBoundingClientRect();
    this.dragCurrent = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    this.redraw();
  }

  protected onMouseUp(event: MouseEvent): void {
    if (!this.dragStart || !this.activeSubjectId()) return;
    const rect = this.canvasRef.nativeElement.getBoundingClientRect();
    const ex = event.clientX - rect.left;
    const ey = event.clientY - rect.top;
    const w = rect.width;
    const h = rect.height;
    const box: BoundingBox = {
      x: Math.max(0, Math.min(this.dragStart.x, ex) / w),
      y: Math.max(0, Math.min(this.dragStart.y, ey) / h),
      width: Math.min(1, Math.abs(ex - this.dragStart.x) / w),
      height: Math.min(1, Math.abs(ey - this.dragStart.y) / h),
    };
    if (box.width > 0.01 && box.height > 0.01) {
      this.boxDrawn.emit({ subjectId: this.activeSubjectId()!, box });
    }
    this.dragStart = null;
    this.dragCurrent = null;
    this.redraw();
  }

  protected onTouchStart(event: TouchEvent): void {
    if (!this.activeSubjectId() || event.touches.length !== 1) return;
    const rect = this.canvasRef.nativeElement.getBoundingClientRect();
    const t = event.touches[0];
    this.dragStart = { x: t.clientX - rect.left, y: t.clientY - rect.top };
    this.dragCurrent = { ...this.dragStart };
    event.preventDefault();
  }

  protected onTouchMove(event: TouchEvent): void {
    if (!this.dragStart || event.touches.length !== 1) return;
    const rect = this.canvasRef.nativeElement.getBoundingClientRect();
    const t = event.touches[0];
    this.dragCurrent = { x: t.clientX - rect.left, y: t.clientY - rect.top };
    this.redraw();
    event.preventDefault();
  }

  protected onTouchEnd(event: TouchEvent): void {
    if (!this.dragStart || !this.activeSubjectId()) return;
    const rect = this.canvasRef.nativeElement.getBoundingClientRect();
    const t = event.changedTouches[0];
    const ex = t.clientX - rect.left;
    const ey = t.clientY - rect.top;
    const w = rect.width;
    const h = rect.height;
    const box: BoundingBox = {
      x: Math.max(0, Math.min(this.dragStart.x, ex) / w),
      y: Math.max(0, Math.min(this.dragStart.y, ey) / h),
      width: Math.min(1, Math.abs(ex - this.dragStart.x) / w),
      height: Math.min(1, Math.abs(ey - this.dragStart.y) / h),
    };
    if (box.width > 0.01 && box.height > 0.01) {
      this.boxDrawn.emit({ subjectId: this.activeSubjectId()!, box });
    }
    this.dragStart = null;
    this.dragCurrent = null;
    this.redraw();
  }

  private redraw(): void {
    const canvas = this.canvasRef?.nativeElement;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    for (const drawn of this.boxes()) {
      const color = this.colorFor(drawn.subjectId);
      const isActive = drawn.subjectId === this.activeSubjectId();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      if (isActive) {
        ctx.setLineDash([6, 3]);
      } else {
        ctx.setLineDash([]);
      }
      ctx.strokeRect(
        drawn.box.x * w,
        drawn.box.y * h,
        drawn.box.width * w,
        drawn.box.height * h
      );
      ctx.setLineDash([]);
    }

    // Draw in-progress drag rectangle
    if (this.dragStart && this.dragCurrent && this.activeSubjectId()) {
      const color = this.colorFor(this.activeSubjectId()!);
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 3]);
      const x = Math.min(this.dragStart.x, this.dragCurrent.x);
      const y = Math.min(this.dragStart.y, this.dragCurrent.y);
      const bw = Math.abs(this.dragCurrent.x - this.dragStart.x);
      const bh = Math.abs(this.dragCurrent.y - this.dragStart.y);
      ctx.strokeRect(x, y, bw, bh);
      ctx.setLineDash([]);
    }
  }

  protected onImageLoad(): void {
    this.syncCanvasSize();
  }

  private syncCanvasSize(): void {
    const img = this.imgRef.nativeElement;
    const canvas = this.canvasRef.nativeElement;
    const rect = img.getBoundingClientRect();
    canvas.width = rect.width;
    canvas.height = rect.height;
    this.redraw();
  }
}
