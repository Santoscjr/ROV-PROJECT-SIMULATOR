/**
 * Captures initialisation / runtime / asset-loading errors so the diagnostics
 * panel can show them (without flooding the console in normal operation).
 */
export interface CapturedError {
  time: string;
  kind: 'erro' | 'promessa' | 'recurso' | 'webgl' | 'inicialização';
  message: string;
}

const MAX = 30;
export const capturedErrors: CapturedError[] = [];

export function recordError(kind: CapturedError['kind'], message: string): void {
  capturedErrors.push({ time: new Date().toISOString().slice(11, 19), kind, message: message.slice(0, 300) });
  if (capturedErrors.length > MAX) capturedErrors.shift();
}

let installed = false;
export function installErrorCapture(win: Window = window): void {
  if (installed) return;
  installed = true;
  win.addEventListener('error', (e) => recordError('erro', `${e.message} (${e.filename?.split('/').pop() ?? ''}:${e.lineno ?? ''})`));
  win.addEventListener('unhandledrejection', (e) => recordError('promessa', String((e as PromiseRejectionEvent).reason)));
  // Failed <script>/<link>/<img> loads do not bubble: listen in the capture phase.
  win.addEventListener(
    'error',
    (e) => {
      const t = e.target as HTMLElement | null;
      if (t && t !== (win as unknown) && 'tagName' in t) {
        const src = (t as HTMLScriptElement).src || (t as HTMLLinkElement).href || '';
        recordError('recurso', `falha ao carregar ${t.tagName.toLowerCase()} ${src}`);
      }
    },
    true,
  );
}
