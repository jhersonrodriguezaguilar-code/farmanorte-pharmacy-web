# FarmaNorte · Página web de farmacias

Página web para que las farmacias publiquen y consulten domicilios en tiempo real, conectada al proyecto real de Supabase.

## Publicación

El repositorio se publica automáticamente en GitHub Pages cada vez que se actualiza `main`.

## Configuración segura

La aplicación usa únicamente:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_PUBLISHABLE_KEY`

Ambas son variables públicas del cliente y se configuran como variables del repositorio en GitHub. No se incluye `.env.local`, una clave `service_role` ni ninguna credencial privada.

## Desarrollo local

```bash
npm ci
copy .env.example .env.local
npm run dev
```
