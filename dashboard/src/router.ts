import { createRouter, createWebHistory } from 'vue-router';
import AuditView from './views/AuditView.vue';
import InstallView from './views/InstallView.vue';
import InstallsView from './views/InstallsView.vue';
import PairView from './views/PairView.vue';

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: InstallsView },
    { path: '/pair', component: PairView },
    { path: '/i/:id([0-9a-f]{32})', component: InstallView, props: true },
    { path: '/i/:id([0-9a-f]{32})/audit', component: AuditView, props: true },
    { path: '/:rest(.*)*', redirect: '/' },
  ],
});
