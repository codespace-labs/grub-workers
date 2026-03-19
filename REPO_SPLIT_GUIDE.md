# Repo Split Guide

Esta es la forma segura de separar `grub` en repos sin romper el runtime actual.

## Nombres exactos de repos en GitHub

Usa estos nombres:

- `grub-mobile`
- `grub-backoffice`
- `grub-backend`
- `grub-workers`

Si usas una organización, el resultado ideal es:

- `github.com/<org>/grub-mobile`
- `github.com/<org>/grub-backoffice`
- `github.com/<org>/grub-backend`
- `github.com/<org>/grub-workers`

## Recomendación clave para no romper nada

Hoy el runtime real de producción y de desarrollo local depende de Supabase Functions y migraciones que viven en `supabase/`.

Para que **no se rompa absolutamente nada**, la separación debe hacerse en este orden:

### Paso 1. Separación real inmediata

- `grub-mobile`
  - Expo app
- `grub-backoffice`
  - Next.js admin app
- `grub-backend`
  - `supabase/` completo
  - migraciones
  - Edge Functions públicas
  - Edge Functions admin
  - Edge Functions de sync/workers por ahora
  - contratos compartidos

### Paso 2. Separación operativa de workers

`grub-workers` se crea desde ya, pero al inicio queda como **repo de extracción progresiva**.

Eso significa:

- puedes mover ahí la lógica pura de scraping, parsing y normalización
- pero los entrypoints desplegables de Supabase Functions siguen viviendo en `grub-backend`
- así localmente y en producción sigues desplegando desde un solo repo de infraestructura

Esta decisión evita:

- romper `supabase functions deploy`
- romper `supabase start` / `functions serve`
- duplicar migraciones en más de un repo
- perder trazabilidad del backend real

En otras palabras:

- `grub-workers` existe ya
- pero **el source of truth desplegable sigue siendo `grub-backend`** hasta que extraigamos la lógica a librerías compartidas

## Qué va a cada repo

### `grub-mobile`

Debe contener:

- `app/`
- `assets/`
- `src/`
- `app.json`
- `index.ts`
- `metro.config.js`
- `package.json`
- `package-lock.json`
- `tsconfig.json`
- opcional: `ios/` limpio si decides mantener nativo versionado

No debe contener:

- `backoffice/`
- `supabase/`
- dashboards operativos
- lógica de scraping

### `grub-backoffice`

Debe contener:

- contenido de `backoffice/` en la raíz del repo
- `packages/contracts/` temporalmente dentro del repo para no romper imports

No debe contener:

- Expo app
- migraciones
- scrapers

### `grub-backend`

Debe contener:

- `supabase/` completo
- `packages/contracts/`
- `scripts/validate-event-quality.mjs`
- documentación operativa

Importante:

- aquí viven las migraciones
- aquí viven las Edge Functions públicas y admin
- aquí siguen viviendo los entrypoints de sync por ahora

### `grub-workers`

Debe contener inicialmente:

- `supabase/functions/_shared/location-normalization.ts`
- `supabase/functions/_shared/venue-upsert.ts`
- `supabase/functions/sync-ticketmaster/`
- `supabase/functions/sync-ticketmaster-pe/`
- `supabase/functions/sync-teleticket/`
- `supabase/functions/enrich-artists/`
- scripts y documentación de calidad

Pero en esta fase:

- **no es el repo desde el que vas a desplegar Supabase todavía**
- es el repo donde iremos moviendo la lógica reusable de workers

## Cómo consumir servicios si no están en la nube

Si no quieres depender de cloud, usa **Supabase local** desde `grub-backend`.

### 1. Levanta backend local

En `grub-backend`:

```bash
supabase start
supabase db reset
supabase functions serve --no-verify-jwt
```

Luego saca las variables reales con:

```bash
supabase status
```

Eso te da:

- API URL
- anon key
- service role key
- Studio URL

### 2. Conecta `grub-mobile` al backend local

En `.env` del mobile:

```bash
EXPO_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
EXPO_PUBLIC_SUPABASE_ANON_KEY=<anon_key_local>
```

La app seguirá consumiendo:

- `api-public-feed-home`
- `api-public-events`
- `api-public-event-detail`
- `api-public-genres`

pero ahora localmente.

### 3. Conecta `grub-backoffice` al backend local

En `.env.local` del backoffice:

```bash
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon_key_local>
```

Luego:

```bash
npm install
npm run dev
```

### 4. Auth local

El backoffice usa Supabase Auth. Para probar local:

- crea usuarios en Supabase local
- asigna `app_metadata.role` con `admin`, `operator` o `viewer`

## Estrategia de despliegue sin romper producción

### Producción hoy

- `grub-backend` despliega todo Supabase
- `grub-mobile` y `grub-backoffice` solo consumen URLs del proyecto

### Producción después

Cuando la lógica de workers ya esté extraída a librerías:

- `grub-workers` publica paquetes o módulos reutilizables
- `grub-backend` conserva entrypoints finos que importan esa lógica

Así mantienes un único punto de despliegue de Supabase y no rompes el pipeline.

## Publicación de contratos

Para no duplicar `packages/contracts` a largo plazo, tienes 2 opciones:

### Opción recomendada luego

Publicar `@grub/contracts` desde `grub-backend` o desde un repo futuro `grub-contracts`.

### Opción segura hoy

Copiar `packages/contracts` dentro de `grub-backoffice` mientras estabilizas el split.

Eso evita romper imports inmediatamente.

## Script de extracción

Usa:

```bash
bash scripts/split-repos.sh
```

Por defecto generará una carpeta hermana:

- `../grub-separated/grub-mobile`
- `../grub-separated/grub-backoffice`
- `../grub-separated/grub-backend`
- `../grub-separated/grub-workers`

Importante:

- el script **no borra este repo**
- copia el estado actual a repos nuevos
- la idea es revisar, inicializar git y subir cada uno a GitHub

## Orden exacto recomendado

1. Ejecutar `scripts/split-repos.sh`
2. Crear los 4 repos vacíos en GitHub con los nombres indicados
3. Subir primero `grub-backend`
4. Probar `supabase start` y `functions serve` en `grub-backend`
5. Subir `grub-mobile`
6. Conectar `grub-mobile` a backend local o staging
7. Subir `grub-backoffice`
8. Verificar auth + roles
9. Subir `grub-workers` como repo de extracción progresiva

## Qué NO hacer todavía

- no mover migraciones a más de un repo
- no tener dos repos distintos desplegando el mismo `supabase/`
- no separar la base de datos
- no hacer que mobile o backoffice lean tablas crudas otra vez

## Resumen ejecutivo

La separación segura hoy es:

- `grub-mobile`: app
- `grub-backoffice`: admin
- `grub-backend`: fuente real de backend + Supabase + deploy
- `grub-workers`: repo de extracción progresiva de lógica de ingestión

Así separamos responsabilidades ya, pero sin romper ni producción ni desarrollo local.
