# Local Runbook

## Objetivo

Usar la arquitectura separada sin mezclar responsabilidades:

- `grub-workers`: scrapers
- `grub-backend`: APIs admin/public, normalización, orquestación
- `grub-backoffice`: interfaz local

## Flujo recomendado

1. Backend desplegado al proyecto Supabase
2. Workers desplegados al mismo proyecto Supabase
3. Backoffice corriendo local y apuntando a ese proyecto

## Deploy backend

Desde `grub-backend`:

```bash
supabase functions deploy api-admin-source-sync --no-verify-jwt
supabase functions deploy api-admin-normalization --no-verify-jwt
supabase functions deploy api-internal-normalization --no-verify-jwt
supabase functions deploy sync-global --no-verify-jwt
```

## Deploy workers

Desde `grub-workers`:

```bash
supabase functions deploy sync-ticketmaster --no-verify-jwt
supabase functions deploy sync-ticketmaster-pe --no-verify-jwt
supabase functions deploy sync-teleticket --no-verify-jwt
supabase functions deploy sync-joinnus --no-verify-jwt
supabase functions deploy sync-passline --no-verify-jwt
supabase functions deploy sync-vastion --no-verify-jwt
supabase functions deploy sync-tikpe --no-verify-jwt
```

## Secrets necesarios

En el proyecto Supabase deben existir como mínimo:

- `FIRECRAWL_API_KEY`
- `GRUB_INTERNAL_API_KEY`
- `DISCOGS_CONSUMER_KEY` o `DISCOGS_USER_TOKEN`
- `DISCOGS_CONSUMER_SECRET` si se usa consumer key

## Correr backoffice local

Desde `grub-backoffice`:

```bash
rm -rf .next
npm run dev
```

Abrir:

```bash
http://localhost:3000/backoffice/scrapers
```

## Cómo funciona el botón Sync

1. Backoffice llama `api-admin-source-sync`
2. `api-admin-source-sync` llama `sync-global`
3. `sync-global` despacha `sync-{source}`
4. `sync-{source}` está desplegada desde `grub-workers`
5. Si hay inserts, `sync-global` dispara normalización batch

## Verificación rápida

Después de un sync:

```sql
select source, count(*)
from public.events
group by source
order by count(*) desc;
```

Y para normalización:

```sql
select count(*) as eventos_sin_genero
from normalization.events_without_genres;
```
