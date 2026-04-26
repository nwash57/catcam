import { CanDeactivateFn, Routes } from '@angular/router';

interface WithDirtyState { isDirty(): boolean; }

const canDeactivateEventDetail: CanDeactivateFn<WithDirtyState> = component =>
  component.isDirty()
    ? confirm('You have unsaved annotation changes. Leave without saving?')
    : true;

export const routes: Routes = [
  {
    path: '',
    loadComponent: () => import('./events-list/events-list').then(m => m.EventsList),
  },
  {
    path: 'events/:id',
    loadComponent: () => import('./event-detail/event-detail').then(m => m.EventDetail),
    canDeactivate: [canDeactivateEventDetail],
  },
  {
    path: 'live',
    loadComponent: () => import('./live/live').then(m => m.LiveView),
  },
  { path: '**', redirectTo: '' },
];
