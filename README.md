# FarmaNorte · página operativa de farmacia

Panel web estático para que el personal autorizado publique domicilios en Supabase. No crea usuarios, no carga datos demo y no permite publicar si el perfil no es de farmacia, la farmacia está inactiva o la zona no está configurada.

## Ejecutar

### Abrir con doble clic en Windows

Desde la carpeta principal del proyecto, ejecuta `ABRIR-PAGINA-FARMACIA.bat`.
También puedes ejecutar `pharmacy_web/ABRIR-PAGINA-FARMACIA.bat`. El script
instala las dependencias si faltan, levanta Vite y abre la página en el
navegador en `http://127.0.0.1:5173`.

La interfaz se puede visualizar aunque todavía no exista `.env.local`. Para
publicar domicilios y consultar Supabase, completa primero las variables
públicas indicadas abajo.

1. Copia `.env.example` como `.env.local`.
2. Completa `VITE_SUPABASE_URL` y `VITE_SUPABASE_PUBLISHABLE_KEY` con los datos públicos del proyecto real.
3. Ejecuta `npm install` y después `npm run dev`.
4. Para GitHub Pages, el flujo de GitHub Actions genera `dist/` y publica el
   resultado automáticamente. Para Hostinger u otro dominio en la raíz,
   ejecuta `npm run build` y sube el contenido de `dist/` al directorio
   público.

La clave `publishable`/`anon` es la única que debe llegar al navegador. Nunca se debe poner una clave `service_role` en esta página.

La página incluye manifiesto PWA y service worker para permitir añadirla a la
pantalla de inicio en iPhone. El service worker se registra explícitamente al
cargar la versión publicada, funciona también si la página está dentro de una
ruta como `/courier/`, cachea la interfaz y abre el pedido o el chat al tocar
una notificación. En `Ajustes` el usuario activa las alertas de este
dispositivo después de conceder el permiso; no se pide permiso de forma
automática al iniciar sesión. Las lecturas, escrituras, autenticación y tiempo
real siguen dependiendo de Supabase.

Al publicar un domicilio o enviar un mensaje, la página invoca la función Edge
`send-push-notification`. Esa función entrega la alerta a los dispositivos de
domiciliarios elegibles mediante FCM y, para navegadores, Web Push. Para
habilitarlo en producción hay que definir en Supabase
`FIREBASE_SERVICE_ACCOUNT_JSON` y los secretos VAPID
`WEB_PUSH_VAPID_PUBLIC_KEY`, `WEB_PUSH_VAPID_PRIVATE_KEY` y
`WEB_PUSH_VAPID_SUBJECT`. Si el permiso o los secretos no están disponibles,
la operación en primer plano no se bloquea. El navegador debe tener permiso de
notificaciones; en iPhone, la web debe instalarse desde Safari en la pantalla
de inicio para recibir Web Push de forma fiable en segundo plano.
