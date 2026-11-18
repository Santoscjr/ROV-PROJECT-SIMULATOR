import './ui/style.css';
import { getLocale, setLocale, t } from './i18n';
import { SettingsStore } from './config/settings';
import { installErrorCapture, recordError } from './diagnostics/errors';

installErrorCapture();

// O idioma tem de valer antes de qualquer t(): HUD, menus e painéis montam o DOM
// uma única vez. Trocar de idioma salva a preferência e recarrega a página.
setLocale(new SettingsStore().get().language);
document.documentElement.lang = getLocale();
document.title = t('app.title');

const container = document.getElementById('app')!;
const loading = document.createElement('div');
loading.className = 'loading';
loading.textContent = t('app.loading');
container.appendChild(loading);

function webglAvailable(): boolean {
  try {
    const c = document.createElement('canvas');
    return !!c.getContext('webgl2');
  } catch {
    return false;
  }
}

async function boot(): Promise<void> {
  if (!webglAvailable()) {
    recordError('webgl', 'WebGL2 indisponível');
    loading.textContent = t('app.webglError');
    loading.style.padding = '24px';
    loading.style.textAlign = 'center';
    return;
  }
  const { App } = await import('./app');
  // Let the loading text paint before the (synchronous) scene build.
  await new Promise((r) => requestAnimationFrame(() => r(null)));
  try {
    new App(container);
    loading.remove();
  } catch (err) {
    console.error(err);
    recordError('inicialização', String(err));
    loading.textContent = t('app.webglError');
  }
}

void boot();
