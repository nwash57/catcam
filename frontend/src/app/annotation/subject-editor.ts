import { Component, input, output, signal } from '@angular/core';
import { ALLOWED_SPECIES, AnnotatedSubject, Species } from '../api';

@Component({
  selector: 'app-subject-editor',
  imports: [],
  templateUrl: './subject-editor.html',
})
export class SubjectEditor {
  readonly subjects = input.required<AnnotatedSubject[]>();
  readonly nameSuggestions = input<Record<string, string[]>>({});
  readonly subjectsChange = output<AnnotatedSubject[]>();

  protected readonly speciesList = ALLOWED_SPECIES;
  protected readonly activeDropdownIndex = signal<number | null>(null);
  private readonly nameQuery = signal<Record<number, string>>({});

  protected addSubject(): void {
    const existing = this.subjects();
    const id = `s${existing.length + 1}_${Date.now()}`;
    this.subjectsChange.emit([...existing, { id, species: 'cat', name: null }]);
  }

  protected updateSpecies(index: number, species: Species): void {
    this.nameQuery.update(q => { const n = { ...q }; delete n[index]; return n; });
    this.subjectsChange.emit(this.subjects().map((s, i) =>
      i === index ? { ...s, species, name: null } : s
    ));
  }

  protected updateName(index: number, name: string): void {
    this.subjectsChange.emit(this.subjects().map((s, i) =>
      i === index ? { ...s, name: name.trim() || null } : s
    ));
  }

  protected removeSubject(index: number): void {
    this.nameQuery.update(q => { const n = { ...q }; delete n[index]; return n; });
    this.subjectsChange.emit(this.subjects().filter((_, i) => i !== index));
  }

  protected openDropdown(i: number): void {
    this.nameQuery.update(q => ({ ...q, [i]: this.subjects()[i]?.name ?? '' }));
    this.activeDropdownIndex.set(i);
  }

  protected onNameBlur(): void {
    setTimeout(() => this.activeDropdownIndex.set(null), 150);
  }

  protected onNameInput(i: number, value: string): void {
    this.nameQuery.update(q => ({ ...q, [i]: value }));
    this.updateName(i, value);
  }

  protected selectName(i: number, name: string): void {
    this.nameQuery.update(q => ({ ...q, [i]: name }));
    this.updateName(i, name);
    this.activeDropdownIndex.set(null);
  }

  protected filteredSuggestions(i: number): string[] {
    const subject = this.subjects()[i];
    if (!subject) return [];
    const all = this.nameSuggestions()[subject.species] ?? [];
    const q = (this.nameQuery()[i] ?? subject.name ?? '').toLowerCase();
    return q ? all.filter(n => n.toLowerCase().includes(q)) : all;
  }
}
