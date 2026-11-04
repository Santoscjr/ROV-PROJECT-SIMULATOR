import './ui/style.css';
import { t } from './i18n';

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
    loading.textContent = t('app.webglError');
  }
}

void boot();
