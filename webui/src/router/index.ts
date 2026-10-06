import { createRouter, createWebHashHistory } from 'vue-router';
import { api } from '@/api/client';

/**
 * Hash history, not HTML5 history.
 *
 * The SPA is mounted at `/admin` by the Nami server, so a deep link like
 * `/admin#/sessions` never reaches the server as a path — no catch-all rewrite
 * rule is needed and a stale bookmark can never 404.
 *
 * Every view is lazily imported so the initial payload stays small.
 */
export const router = createRouter({
  history: createWebHashHistory('/admin/'),
  routes: [
    {
      path: '/login',
      name: 'login',
      component: () => import('@/views/LoginView.vue'),
      meta: { title: '登录', public: true, bare: true },
    },
    {
      path: '/',
      name: 'dashboard',
      component: () => import('@/views/DashboardView.vue'),
      meta: { title: '仪表盘', icon: 'mdiViewDashboardOutline' },
    },
    {
      path: '/chat',
      name: 'chat',
      component: () => import('@/views/ChatView.vue'),
      meta: { title: '对话', icon: 'mdiChatProcessingOutline' },
    },
    {
      path: '/sessions',
      name: 'sessions',
      component: () => import('@/views/SessionsView.vue'),
      meta: { title: '会话', icon: 'mdiCommentMultipleOutline' },
    },
    {
      path: '/models',
      name: 'models',
      component: () => import('@/views/ModelsView.vue'),
      meta: { title: '模型', icon: 'mdiCubeOutline' },
    },
    {
      path: '/tools',
      name: 'tools',
      component: () => import('@/views/ToolsView.vue'),
      meta: { title: '工具', icon: 'mdiToolboxOutline' },
    },
    {
      path: '/onebot',
      name: 'onebot',
      component: () => import('@/views/OneBotView.vue'),
      meta: { title: 'OneBot / QQ', icon: 'mdiQqchat' },
    },
    {
      path: '/config',
      name: 'config',
      component: () => import('@/views/ConfigView.vue'),
      meta: { title: '配置', icon: 'mdiTuneVariant' },
    },
    {
      path: '/logs',
      name: 'logs',
      component: () => import('@/views/LogsView.vue'),
      meta: { title: '日志', icon: 'mdiTextBoxSearchOutline' },
    },
    {
      path: '/api',
      name: 'api',
      component: () => import('@/views/ApiDocsView.vue'),
      meta: { title: 'API 文档', icon: 'mdiApi' },
    },
    {
      path: '/:pathMatch(.*)*',
      name: 'not-found',
      component: () => import('@/views/NotFoundView.vue'),
      meta: { title: '未找到' },
    },
  ],
});

/**
 * Route guard.
 *
 * Only checks that a credential *exists*; it deliberately does not validate it
 * on every navigation. A stale credential is discovered by the first real
 * request, whose 401/403 flows back through the shell so the operator lands on
 * the login page with a concrete reason instead of a silent redirect.
 */
router.beforeEach((to) => {
  if (to.meta.public === true) return true;
  if (!api.authenticated) {
    return { name: 'login', query: to.fullPath === '/' ? {} : { redirect: to.fullPath } };
  }
  return true;
});

router.afterEach((to) => {
  const title = typeof to.meta.title === 'string' ? to.meta.title : '';
  document.title = title === '' ? 'Nami · 控制台' : `${title} · Nami`;
});
