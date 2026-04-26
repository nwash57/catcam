import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    path: '',
    loadComponent: () => import('./events-list/events-list').then(m => m.EventsList),
  },
  {
    path: 'events/:id',
    loadComponent: () => import('./event-detail/event-detail').then(m => m.EventDetail),
  },
  {
    path: 'live',
    loadComponent: () => import('./live/live').then(m => m.LiveView),
  },
  { path: '**', redirectTo: '' },
];
