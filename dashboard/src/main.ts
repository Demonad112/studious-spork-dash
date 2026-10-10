import { createApp } from 'vue';
import App from './App.vue';
import { router } from './router.ts';
import { initTheme } from './lib/theme.ts';
import './style.css';

initTheme();
createApp(App).use(router).mount('#app');
