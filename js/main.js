import { installTooltips } from './ui.js';
import { installAccount } from './account.js';
import { renderLanding } from './views/landing.js';
import { renderStudio } from './views/studio.js';
import { renderDashboard } from './views/dashboard.js';
import { renderMethod } from './views/method.js';
import { renderReport } from './views/report.js';

const view = document.getElementById('view');
let cleanup = null;

function route() {
  const [name = '', arg] = location.hash.replace(/^#\/?/, '').split('/');
  if (cleanup) { cleanup(); cleanup = null; }
  view.innerHTML = '';
  document.body.dataset.route = name || 'home';
  document.querySelectorAll('[data-route]').forEach((a) => {
    if (a.dataset.route === name) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
  const routes = {
    '': renderLanding, studio: renderStudio, dashboard: renderDashboard, method: renderMethod, report: renderReport,
  };
  cleanup = (routes[name] || renderLanding)(view, arg) || null;
  window.scrollTo(0, 0);
}

installTooltips();
addEventListener('hashchange', route);
addEventListener('mishraq:project-replaced', route);
installAccount();
route();
