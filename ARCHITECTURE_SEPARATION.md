# Separación de capas — Fase 1 implementada

## Qué quedó creado en este repo

- `backoffice/`
  - app Next.js para overview, eventos, calidad, syncs, auditoría y auth
- `packages/contracts/`
  - contratos compartidos entre clientes y capa backend
- `supabase/functions/api-public-*`
  - endpoints públicos para app y futuros consumidores
- `supabase/functions/api-admin-*`
  - endpoints admin para backoffice, roles, quality actions, syncs y auditoría
- `supabase/migrations/20260318000800_platform_foundation.sql`
  - base operativa: sync runs, issues, overrides, auditoría

## Cómo se extrae luego a repos separados

### repo-mobile
- mover `app/`, `src/`, `assets/`, `app.json`, `package.json` móvil

### repo-backoffice
- mover `backoffice/`

### repo-backend
- mover `packages/contracts/`
- mover `supabase/functions/api-public-*`
- mover `supabase/functions/api-admin-*`
- conservar migraciones y contratos de acceso
 - exponer superficie pública y admin sin acoplar clientes a tablas

### repo-workers
- mover `supabase/functions/sync-*`
- mover `supabase/functions/enrich-artists`
- mover `supabase/functions/reclassify-event-genres` cuando exista
- mantener `_shared/` que sea operativo de workers

## Estado actual de la fase

- mobile ya consume `api-public-*` en sus hooks principales
- backoffice ya tiene auth con Supabase Auth + roles
- backoffice ya puede:
  - listar usuarios y cambiar roles
  - activar/desactivar eventos
  - resolver/ignorar quality issues
  - disparar syncs manuales
  - revisar auditoría y overrides
