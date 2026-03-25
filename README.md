# grub-workers

Repo operativo de scraping y jobs de ingestión.

## Responsabilidad

- `sync-*`
- futuros jobs de backfill y reclasificación
- lógica pesada de scraping / crawling

## Relación con `grub-backend`

- `grub-backend` expone APIs admin y públicas
- `grub-backend` mantiene `api-admin-source-sync` y `sync-global`
- `sync-global` llama por HTTP a funciones `sync-*` desplegadas desde este repo

En otras palabras:

- backend orquesta
- workers scrapean

## Deploy recomendado

Desplegar desde este repo las funciones:

- `sync-ticketmaster`
- `sync-ticketmaster-pe`
- `sync-teleticket`
- `sync-joinnus`
- `sync-passline`
- `sync-vastion`
- `sync-tikpe`

Todas apuntan al mismo proyecto Supabase que usa el backend.
