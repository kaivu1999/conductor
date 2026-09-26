/** Folder names for new projects. Shared so the UI previews exactly what the server creates. */

/** "Weather App!" -> "weather-app". Empty if nothing usable is left. */
export function slugify(name: string): string {
  return name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-').replace(/-{2,}/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 64);
}
