import { config } from './config.js';

/**
 * Авто-пингер для предотвращения засыпания сервера на бесплатных тарифах (Render.com).
 * На бесплатном тарифе Render усыпляет сервис через 15 минут бездействия.
 * Пингуя публичный URL каждые 9 минут, сервис постоянно держит себя активным.
 */
export function startAutoPinger() {
  const targetUrl = config.publicUrl
    ? `${config.publicUrl}/health`
    : `http://127.0.0.1:${config.port}/health`;

  const intervalMs = 9 * 60 * 1000; // 9 минут

  const ping = async () => {
    try {
      const res = await fetch(targetUrl, {
        method: 'GET',
        headers: { 'User-Agent': 'FreeStars-AutoPinger/1.0' },
        signal: AbortSignal.timeout(15000),
      });
      console.log(`[pinger] Auto-ping: ${targetUrl} (HTTP ${res.status})`);
    } catch (err) {
      console.warn(`[pinger] Auto-ping warning (${targetUrl}): ${err.message}`);
    }
  };

  // Первый пинг через 20 секунд после старта, затем каждые 9 минут
  const initialTimer = setTimeout(ping, 20_000);
  initialTimer.unref?.();

  const intervalTimer = setInterval(ping, intervalMs);
  intervalTimer.unref?.();

  console.log(`[freestars] авто-пингер запущен: интервал 9 мин -> ${targetUrl}`);

  return {
    stop: () => {
      clearTimeout(initialTimer);
      clearInterval(intervalTimer);
    },
    pingNow: ping,
  };
}
