import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createClient } from '@supabase/supabase-js';
import { toPng } from 'html-to-image';
import { jsPDF } from 'jspdf';
import './styles.css';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const SUPABASE_PUBLISHABLE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
const supabase = SUPABASE_URL && SUPABASE_PUBLISHABLE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY)
  : null;

let webAppServiceWorkerPromise = null;

function getWebPushCapability() {
  const hasWindow = typeof window !== 'undefined';
  const browserSupported = hasWindow
    && 'serviceWorker' in navigator
    && 'PushManager' in window
    && 'Notification' in window;
  const configured = Boolean(import.meta.env.VITE_WEB_PUSH_PUBLIC_KEY);
  const productionBuild = Boolean(import.meta.env.PROD);
  const permission = hasWindow && 'Notification' in window ? Notification.permission : 'unsupported';
  return {
    browserSupported,
    configured,
    productionBuild,
    supported: browserSupported && configured && productionBuild,
    permission,
  };
}

function getInitialWebPushState() {
  return {
    ...getWebPushCapability(),
    enabled: false,
    loading: false,
    message: '',
    error: '',
  };
}

function getWebAppBaseUrl() {
  return new URL('./', document.baseURI);
}

async function registerWebAppServiceWorker() {
  if (typeof window === 'undefined' || !import.meta.env.PROD || !('serviceWorker' in navigator)) return null;
  if (!webAppServiceWorkerPromise) {
    const baseUrl = getWebAppBaseUrl();
    const scope = baseUrl.pathname;
    const candidates = [
      new URL('sw.js', baseUrl),
      new URL('../sw.js', baseUrl),
      new URL('../../sw.js', baseUrl),
    ].filter((candidate, index, all) => all.findIndex((item) => item.href === candidate.href) === index);
    webAppServiceWorkerPromise = (async () => {
      let lastError = null;
      for (const candidate of candidates) {
        try {
          const response = await fetch(candidate.href, { cache: 'no-store' });
          if (!response.ok) continue;
          return await navigator.serviceWorker.register(candidate.href, { scope });
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError || new Error('No se encontró el Service Worker de la web.');
    })().catch((error) => {
      webAppServiceWorkerPromise = null;
      throw error;
    });
  }
  return webAppServiceWorkerPromise;
}

async function getCurrentWebPushSubscription() {
  const registration = await registerWebAppServiceWorker();
  if (!registration?.pushManager) return null;
  return registration.pushManager.getSubscription();
}

// Las notificaciones push no deben bloquear la publicación ni el chat. La web
// sincroniza su suscripción en Supabase solo después de que el usuario concede
// permiso; así el navegador no muestra un diálogo inesperado al iniciar sesión.
function triggerPushNotification(body) {
  if (!supabase) return;
  void supabase.functions.invoke('send-push-notification', { body }).then(({ error }) => {
    if (error) console.warn('No se pudo emitir la notificación push:', error.message || error);
  });
}

function base64UrlToUint8Array(value) {
  const padding = '='.repeat((4 - (value.length % 4)) % 4);
  const base64 = `${value}${padding}`.replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(base64);
  return Uint8Array.from([...raw].map((character) => character.charCodeAt(0)));
}

async function registerWebPushSubscription(userId, { requestPermission = false } = {}) {
  const capability = getWebPushCapability();
  const baseState = { ...getInitialWebPushState(), loading: false };
  const publicKey = import.meta.env.VITE_WEB_PUSH_PUBLIC_KEY;
  if (!publicKey || !supabase || !userId || !capability.supported) {
    return {
      ...baseState,
      message: !capability.configured
        ? 'Las alertas en segundo plano todavía no están configuradas por el administrador.'
        : !capability.productionBuild
          ? 'Las alertas se activan en la versión publicada de la web.'
          : !capability.browserSupported
            ? 'Este navegador no admite alertas Web Push para esta página.'
            : '',
    };
  }
  try {
    let permission = Notification.permission;
    if (permission === 'default' && requestPermission) permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      return {
        ...baseState,
        permission,
        error: permission === 'denied'
          ? 'El navegador bloqueó las alertas. Actívalas en los permisos del sitio.'
          : '',
      };
    }
    const registration = await registerWebAppServiceWorker();
    if (!registration?.pushManager) throw new Error('No se pudo activar el Service Worker.');
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: base64UrlToUint8Array(publicKey),
      });
    }
    const token = JSON.stringify(subscription.toJSON());
    const { error: tokenError } = await supabase.from('push_tokens').upsert({
      user_id: userId,
      token,
      platform: 'web',
      active: true,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'token' });
    if (tokenError) throw tokenError;
    return {
      ...baseState,
      permission,
      enabled: true,
      message: 'Alertas en segundo plano activas en este dispositivo.',
    };
  } catch (error) {
    console.warn('No se pudo registrar la notificación web:', error?.message || error);
    return {
      ...baseState,
      error: 'No se pudo activar la alerta. Revisa el permiso del navegador e inténtalo de nuevo.',
    };
  }
}

async function deactivateWebPushSubscription(userId) {
  if (!supabase || !userId) return false;
  try {
    const subscription = await getCurrentWebPushSubscription();
    if (!subscription) return true;
    const token = JSON.stringify(subscription.toJSON());
    const { error } = await supabase
      .from('push_tokens')
      .update({ active: false, updated_at: new Date().toISOString() })
      .eq('user_id', userId)
      .eq('token', token);
    if (error) throw error;
    return true;
  } catch (error) {
    console.warn('No se pudo desactivar la alerta web:', error?.message || error);
    return false;
  }
}

const PAYMENT_LABELS = {
  cash: 'Efectivo',
  card: 'Tarjeta',
  qr: 'QR',
};

const SERVICE_TYPES = [
  {
    value: 'Domicilio normal',
    label: 'Domicilio',
    description: 'Recogida en esta farmacia y entrega al cliente.',
    kind: 'pharmacyToHome',
    requiresClient: true,
    requiresPayment: true,
    placeholder: 'Ej. 2 cajas de acetaminofén y 1 jarabe.',
  },
  {
    value: 'Compra externa',
    label: 'Compra externa',
    description: 'El domiciliario compra un producto fuera de la red.',
    kind: 'externalPurchase',
    requiresPurchase: true,
    placeholder: 'Producto, cantidad, lugar de compra y cómo identificarlo.',
  },
  {
    value: 'Cruce farmacia',
    label: 'Cruce',
    description: 'Producto que se recoge en otra farmacia de la red.',
    kind: 'pharmacyCross',
    requiresCross: true,
    placeholder: 'Farmacia de origen, farmacia destino, producto y cantidad.',
  },
  {
    value: 'Domicilio + compra',
    label: 'Domicilio + compra',
    description: 'Entrega al cliente con una compra externa incluida.',
    kind: 'combinedService',
    requiresClient: true,
    requiresPayment: true,
    requiresPurchase: true,
    placeholder: 'Productos de farmacia, compra externa, cantidades e instrucciones.',
  },
  {
    value: 'Domicilio + cruce',
    label: 'Domicilio + cruce',
    description: 'Entrega al cliente con un cruce entre farmacias.',
    kind: 'combinedService',
    requiresClient: true,
    requiresPayment: true,
    requiresCross: true,
    placeholder: 'Farmacia de origen, cruce, productos y datos de entrega.',
  },
  {
    value: 'Domicilio + compra + cruce',
    label: 'Domicilio + compra + cruce',
    description: 'Combina entrega, compra externa y cruce.',
    kind: 'combinedService',
    requiresClient: true,
    requiresPayment: true,
    requiresPurchase: true,
    requiresCross: true,
    placeholder: 'Describe la compra, el cruce, los productos y la ruta de entrega.',
  },
];

const DELIVERY_STATUS = {
  offered: ['Publicado', 'status-offered'],
  accepted: ['Aceptado', 'status-accepted'],
  pickedUp: ['En recorrido', 'status-picked'],
  delivered: ['Entregado', 'status-delivered'],
  notDelivered: ['No entregado', 'status-alert'],
  cancelled: ['Cancelado', 'status-cancelled'],
  expired: ['Vencido', 'status-cancelled'],
};

function createRowId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function createPurchaseItem() {
  return {
    id: createRowId('purchase'),
    merchant: '',
    branch: '',
    product: '',
    quantity: '1',
    notes: '',
  };
}

function createCrossStop() {
  return {
    id: createRowId('cross'),
    originPharmacyCode: '',
    destinationPharmacyCode: '',
    product: '',
    quantity: '1',
    notes: '',
  };
}

function createEmptyForm() {
  return {
    clientName: '',
    clientPhone: '',
    address: '',
    notes: '',
    paymentMethod: 'cash',
    paymentAmount: '',
    cashExpected: '',
    serviceType: 'Domicilio normal',
    kind: 'pharmacyToHome',
    purchaseItems: [],
    crossStops: [],
  };
}

const emptyForm = createEmptyForm();

function formatMoney(value) {
  const amount = Number(value || 0);
  return new Intl.NumberFormat('es-CO', {
    style: 'currency',
    currency: 'COP',
    maximumFractionDigits: 0,
  }).format(amount);
}

function formatDate(value) {
  if (!value) return 'Sin fecha';
  return new Intl.DateTimeFormat('es-CO', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function localDateIso(date = new Date()) {
  const localDate = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return localDate.toISOString().slice(0, 10);
}

function formatTime(value) {
  return value ? String(value).slice(0, 5) : '—';
}

function formatPharmacyDisplay(pharmacy) {
  const rawCode = String(pharmacy?.code ?? '').trim();
  const code = rawCode.replace(/^FN\s+/i, '').trim();
  return code ? `farmanorte ${code}` : 'farmanorte';
}

function formatPharmacyCodeLabel(code) {
  const normalized = String(code ?? '').trim().replace(/^FN\s+/i, '');
  return normalized ? `FN ${normalized.toUpperCase()}` : 'FN';
}

function formatDeliveryPublicCode(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  const compact = raw.toUpperCase().replace(/[\s_-]+/g, '');
  return /^FN\d{4,}$/.test(compact) ? compact : raw.toUpperCase();
}

function getServiceTypeConfig(value) {
  return SERVICE_TYPES.find((service) => service.value === value) ?? SERVICE_TYPES[0];
}

function formatPharmacyOption(pharmacy) {
  return formatPharmacyDisplay(pharmacy);
}

function buildProductSummary(form) {
  const purchaseSummary = form.purchaseItems
    .map((item) => `${item.merchant} ${item.branch}: ${item.product} x${item.quantity}`)
    .join(' | ');
  const crossSummary = form.crossStops
    .map((stop) => `${stop.originPharmacyCode} → ${stop.destinationPharmacyCode}: ${stop.product} x${stop.quantity}`)
    .join(' | ');
  const summary = [purchaseSummary && `Compras: ${purchaseSummary}`, crossSummary && `Cruces: ${crossSummary}`]
    .filter(Boolean)
    .join(' · ');
  return summary || 'Productos gestionados por la farmacia.';
}

function buildDeliveryTasks(form) {
  const purchaseTasks = form.purchaseItems.map((item, index) => ({
    sequence_no: index + 1,
    task_type: 'purchase',
    merchant_name: item.merchant.trim(),
    merchant_branch: item.branch.trim(),
    product: item.product.trim(),
    quantity: Number(item.quantity),
    notes: item.notes.trim() || null,
    return_to_pharmacy: false,
  }));
  const crossTasks = form.crossStops.map((stop, index) => ({
    sequence_no: purchaseTasks.length + index + 1,
    task_type: 'cross',
    origin_pharmacy_code: stop.originPharmacyCode,
    destination_pharmacy_code: stop.destinationPharmacyCode,
    product: stop.product.trim(),
    quantity: Number(stop.quantity),
    notes: stop.notes.trim() || null,
    return_to_pharmacy: false,
  }));
  return [...purchaseTasks, ...crossTasks];
}

function getErrorMessage(error) {
  if (!error) return 'Ocurrió un error inesperado.';
  if (error.message?.includes('Invalid login credentials')) {
    return 'Correo o contraseña incorrectos.';
  }
  if (error.message?.includes('Failed to fetch')) {
    return 'No se pudo conectar con Supabase. Revisa la conexión.';
  }
  return error.message || 'Ocurrió un error inesperado.';
}

let notificationAudioContext;
let notificationAudio;

function playNotificationTone(kind = 'message') {
  try {
    notificationAudio ||= new Audio(`${import.meta.env.BASE_URL}fast-ping-notification.mp3`);
    notificationAudio.currentTime = 0;
    void notificationAudio.play().catch(() => {});
    return;
  } catch (_) {
    // Si el navegador bloquea el MP3, se intenta con el tono breve de respaldo.
  }
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    notificationAudioContext ||= new AudioContext();
    const context = notificationAudioContext;
    if (context.state === 'suspended') void context.resume().catch(() => {});
    const now = context.currentTime;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(kind === 'delivery' ? 740 : 560, now);
    oscillator.frequency.exponentialRampToValueAtTime(kind === 'delivery' ? 980 : 760, now + 0.12);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.12, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.3);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start(now);
    oscillator.stop(now + 0.32);
  } catch (_) {
    // El navegador puede bloquear audio hasta que exista una interacción.
  }
}

function normalizeAuthIdentifier(value) {
  const normalized = value.trim().toLowerCase();
  return normalized.includes('@') ? normalized : `${normalized}@farmanorte.local`;
}

const BRAND_LOGO_SRC = `${import.meta.env.BASE_URL}farmanorte-brand.png`;

function BrandLogo({ inverse = false }) {
  return (
    <div className={inverse ? 'brand-logo-inverse brand-logo-image' : 'brand-logo brand-logo-image'} role="img" aria-label="farmanorte">
      <img src={BRAND_LOGO_SRC} alt="" width="255" height="73" loading="eager" />
    </div>
  );
}

const HERO_TITLE = 'Cada entrega, siempre registrada.';
const HERO_COPY = 'Publica, sigue y deja registrado cada domicilio desde el punto de farmacia.';

function LoginHeroCopy({ headingId }) {
  const [visibleTitle, setVisibleTitle] = useState('');
  const [visibleCopy, setVisibleCopy] = useState('');
  const [reducedMotion, setReducedMotion] = useState(false);

  useEffect(() => {
    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    const syncMotionPreference = () => setReducedMotion(mediaQuery.matches);
    syncMotionPreference();
    mediaQuery.addEventListener?.('change', syncMotionPreference);
    return () => mediaQuery.removeEventListener?.('change', syncMotionPreference);
  }, []);

  useEffect(() => {
    if (reducedMotion) {
      setVisibleTitle(HERO_TITLE);
      setVisibleCopy(HERO_COPY);
      return undefined;
    }

    let titleIndex = 0;
    let copyIndex = 0;
    let phase = 'title';
    let timer;

    const tick = () => {
      if (document.hidden) {
        timer = window.setTimeout(tick, 900);
        return;
      }

      if (phase === 'title') {
        titleIndex = Math.min(titleIndex + 1, HERO_TITLE.length);
        setVisibleTitle(HERO_TITLE.slice(0, titleIndex));
        if (titleIndex === HERO_TITLE.length) {
          phase = 'copy';
          timer = window.setTimeout(tick, 280);
          return;
        }
        timer = window.setTimeout(tick, 118);
        return;
      }

      if (phase === 'copy') {
        copyIndex = Math.min(copyIndex + 1, HERO_COPY.length);
        setVisibleCopy(HERO_COPY.slice(0, copyIndex));
        if (copyIndex === HERO_COPY.length) {
          phase = 'hold';
          timer = window.setTimeout(tick, 2200);
          return;
        }
        timer = window.setTimeout(tick, 56);
        return;
      }

      setVisibleTitle('');
      setVisibleCopy('');
      titleIndex = 0;
      copyIndex = 0;
      phase = 'title';
      timer = window.setTimeout(tick, 620);
    };

    timer = window.setTimeout(tick, 520);
    return () => window.clearTimeout(timer);
  }, [reducedMotion]);

  return (
    <>
      <span className="section-kicker">Red de domicilios</span>
      <div className="hero-copy-animated" aria-hidden="true">
        <h1 id={headingId}>{visibleTitle}<span className="hero-caret">|</span></h1>
        <p>{visibleCopy}</p>
      </div>
      <span className="sr-only">{HERO_TITLE} {HERO_COPY}</span>
    </>
  );
}

function LoginRouteMotion() {
  const routeRef = useRef(null);

  useEffect(() => {
    const route = routeRef.current;
    if (!route) return undefined;

    const measureRoute = () => {
      const distance = Math.max(0, route.clientWidth - 18);
      route.style.setProperty('--route-distance', `${distance}px`);
      route.style.setProperty('--route-half-distance', `${distance / 2}px`);
    };

    measureRoute();
    const observer = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(measureRoute);
    observer?.observe(route);
    return () => observer?.disconnect();
  }, []);

  return (
    <div className="hero-route" aria-hidden="true">
      <div className="hero-route-track">
        <span className="hero-route-node route-node-one" />
        <span className="hero-route-node route-node-two" />
        <span className="hero-route-node route-node-three" />
        <span className="hero-route-runner" ref={routeRef} />
      </div>
      <span className="hero-route-label">RUTA ACTIVA · EN VIVO</span>
    </div>
  );
}

function LoginDeliveryScene() {
  return (
    <div className="login-delivery-scene" aria-hidden="true">
      <svg className="delivery-scene-art" viewBox="0 0 520 260" focusable="false">
        <path className="scene-route-shadow" d="M82 211 C155 184 188 230 257 202 S355 176 438 209" />
        <path className="scene-route" d="M82 211 C155 184 188 230 257 202 S355 176 438 209" />
        <circle className="scene-route-node scene-node-one" cx="82" cy="211" r="5" />
        <circle className="scene-route-node scene-node-two" cx="257" cy="202" r="5" />
        <circle className="scene-route-node scene-node-three" cx="438" cy="209" r="5" />

        <g className="scene-phone">
          <rect x="72" y="51" width="84" height="144" rx="14" fill="#f8fcff" stroke="#a8cdef" strokeWidth="3" />
          <rect x="81" y="64" width="66" height="112" rx="7" fill="#e5f2ff" />
          <rect x="96" y="57" width="36" height="5" rx="2.5" fill="#a8cdef" />
          <circle cx="114" cy="184" r="4" fill="#a8cdef" />
          <path className="scene-phone-route" d="M94 133 C105 121 111 151 123 137 S136 128 141 114" fill="none" stroke="#2151aa" strokeWidth="3" strokeLinecap="round" strokeDasharray="5 6" />
          <circle cx="95" cy="133" r="5" fill="#2151aa" />
          <circle cx="141" cy="114" r="5" fill="#6eb2f0" />
          <path d="M112 101h9M105 109h23" stroke="#7cadd7" strokeWidth="3" strokeLinecap="round" />
          <path d="M101 152h25M101 159h18" stroke="#9bc4e8" strokeWidth="3" strokeLinecap="round" />
        </g>

        <g className="scene-pharmacy">
          <path d="M225 123 285 91l61 32v78h-121z" fill="#c7e1f8" stroke="#86b8e8" strokeWidth="3" strokeLinejoin="round" />
          <path d="m225 123 60-32 61 32" fill="none" stroke="#f8fcff" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" />
          <rect x="240" y="138" width="32" height="63" rx="3" fill="#edf7ff" stroke="#86b8e8" strokeWidth="3" />
          <rect x="286" y="139" width="43" height="29" rx="4" fill="#edf7ff" stroke="#86b8e8" strokeWidth="3" />
          <path d="M307.5 145v17M299 153.5h17" stroke="#2151aa" strokeWidth="5" strokeLinecap="round" />
          <path d="M234 121h102" stroke="#edf7ff" strokeWidth="6" strokeLinecap="round" />
          <circle cx="248" cy="128" r="3" fill="#2151aa" />
          <circle cx="319" cy="128" r="3" fill="#2151aa" />
        </g>

        <g className="scene-package">
          <path d="m354 160 30-15 29 15-30 17z" fill="#f8fcff" stroke="#a8cdef" strokeWidth="3" strokeLinejoin="round" />
          <path d="m354 160 1 30 28 17 1-30zM413 160l-1 30-29 17 1-30z" fill="#b8d9f6" stroke="#86b8e8" strokeWidth="3" strokeLinejoin="round" />
          <path d="m383 145 1 32M369 153l29 16" stroke="#2151aa" strokeWidth="3" strokeLinecap="round" />
        </g>

        <g className="scene-courier">
          <circle cx="433" cy="137" r="13" fill="#f8fcff" stroke="#a8cdef" strokeWidth="3" />
          <path d="M421 135c2-13 20-18 27-4-8-3-17-2-27 4z" fill="#d6ebfc" />
          <path d="M416 158c5-12 26-13 34 0l11 24h-57z" fill="#eaf6ff" stroke="#a8cdef" strokeWidth="3" strokeLinejoin="round" />
          <path d="M448 164h17l11 16-15 7-17-15z" fill="#2151aa" opacity=".88" />
          <path d="M429 183h42" stroke="#86b8e8" strokeWidth="3" strokeLinecap="round" />
          <path d="M420 185 400 211h71l-17-26M410 211l-9 11M460 211l9 11" fill="none" stroke="#f8fcff" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
          <circle cx="401" cy="225" r="13" fill="#d8ecfc" stroke="#86b8e8" strokeWidth="3" />
          <circle cx="469" cy="225" r="13" fill="#d8ecfc" stroke="#86b8e8" strokeWidth="3" />
          <circle cx="401" cy="225" r="4" fill="#2151aa" />
          <circle cx="469" cy="225" r="4" fill="#2151aa" />
        </g>

        <path className="scene-spark spark-one" d="m199 112 5 10 10 5-10 5-5 10-5-10-10-5 10-5z" fill="#f8fcff" />
        <path className="scene-spark spark-two" d="m370 92 3 7 7 3-7 3-3 7-3-7-7-3 7-3z" fill="#8fc4f4" />
      </svg>
      <span className="scene-caption"><span className="scene-caption-dot" /> Ruta conectada en tiempo real</span>
    </div>
  );
}

function LoginFormAtmosphere({ orbitRef, glowRef }) {
  return (
    <div className="login-atmosphere" aria-hidden="true">
      <div className="login-atmosphere-glow" ref={glowRef} />
      <div className="login-atmosphere-orbit" ref={orbitRef}>
        <span className="atmosphere-ring ring-one" />
        <span className="atmosphere-ring ring-two" />
        <span className="atmosphere-ring ring-three" />
        <span className="atmosphere-core" />
      </div>
      <span className="atmosphere-star star-one" />
      <span className="atmosphere-star star-two" />
      <span className="atmosphere-star star-three" />
      <span className="atmosphere-star star-four" />
    </div>
  );
}

function LoginAmbient() {
  return (
    <div className="login-ambient" aria-hidden="true">
      <span className="ambient-orbit ambient-orbit-one" />
      <span className="ambient-orbit ambient-orbit-two" />
      <span className="ambient-orbit ambient-orbit-three" />
      <span className="ambient-core" />
      <span className="ambient-star ambient-star-one" />
      <span className="ambient-star ambient-star-two" />
      <span className="ambient-star ambient-star-three" />
      <span className="ambient-star ambient-star-four" />
    </div>
  );
}

function UserIcon() {
  return <svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="6.5" r="3" /><path d="M4.5 16c.7-2.6 2.6-4 5.5-4s4.8 1.4 5.5 4" /></svg>;
}

function LockIcon() {
  return <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="4.5" y="8.5" width="11" height="8" rx="2" /><path d="M7 8.5V6.8a3 3 0 0 1 6 0v1.7" /></svg>;
}

function EyeIcon({ hidden = false }) {
  return hidden
    ? <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m4 4 12 12M8.2 7.1A5.7 5.7 0 0 0 4 10c1.2 2.1 3.2 3.2 6 3.2 1 0 1.9-.2 2.7-.5M11.8 12.9A5.7 5.7 0 0 0 16 10c-1.2-2.1-3.2-3.2-6-3.2-.5 0-1 0-1.5.1" /></svg>
    : <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M2.8 10s2.4-4 7.2-4 7.2 4 7.2 4-2.4 4-7.2 4-7.2-4-7.2-4Z" /><circle cx="10" cy="10" r="2" /></svg>;
}

function ArrowIcon() {
  return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 10h13M11 5l5 5-5 5" /></svg>;
}

function ShieldIcon() {
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5 19 6v5.3c0 4.2-2.5 7.4-7 9.2-4.5-1.8-7-5-7-9.2V6l7-2.5Z" /><path d="m9 12 2 2 4-4" /></svg>;
}

function NavIcon({ name }) {
  const paths = {
    publish: <><path d="M12 5v14M5 12h14" /><path d="M5.5 19.5h13" /></>,
    orders: <><path d="M6.5 4.5h11v15h-11z" /><path d="M9 8h6M9 12h6M9 16h3" /></>,
    schedule: <><rect x="4.5" y="5.5" width="15" height="14" rx="2" /><path d="M8 3.5v4M16 3.5v4M4.5 9.5h15" /><path d="M8 13h.01M12 13h.01M16 13h.01M8 16h.01M12 16h.01" /></>,
    settings: <><path d="M12 8.2a3.8 3.8 0 1 0 0 7.6 3.8 3.8 0 0 0 0-7.6Z" /><path d="m19.4 13.6 1.1.9-1.7 3-1.4-.5a7.9 7.9 0 0 1-1.8 1l-.2 1.5h-3.4l-.2-1.5a7.9 7.9 0 0 1-1.8-1l-1.4.5-1.7-3 1.1-.9a7.5 7.5 0 0 1 0-2.1l-1.1-.9 1.7-3 1.4.5a7.9 7.9 0 0 1 1.8-1l.2-1.5h3.4l.2 1.5a7.9 7.9 0 0 1 1.8 1l1.4-.5 1.7 3-1.1.9a7.5 7.5 0 0 1 0 2.1Z" /></>,
    reception: <><path d="M5 9.5h14v9H5zM7.5 9.5V6.8h9v2.7M8 13h8M8 16h5" /><path d="M3.5 18.5h17" /></>,
  };
  return <svg className="nav-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name] || paths.publish}</svg>;
}

function PasswordRecoveryScreen({ onComplete }) {
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event) => {
    event.preventDefault();
    setError('');
    if (password.length < 8) {
      setError('La contraseña debe tener al menos 8 caracteres.');
      return;
    }
    if (password !== confirmation) {
      setError('Las contraseñas no coinciden.');
      return;
    }
    setSubmitting(true);
    const { error: updateError } = await supabase.auth.updateUser({ password });
    if (updateError) {
      setError('No se pudo actualizar la contraseña. Solicita un nuevo enlace e inténtalo nuevamente.');
      setSubmitting(false);
      return;
    }
    await supabase.auth.signOut();
    onComplete();
  };

  return (
    <div className="auth-page recovery-page">
      <div className="auth-aside recovery-aside">
        <div className="brand-lockup"><BrandLogo inverse /></div>
        <div className="recovery-copy"><span className="section-kicker">SEGURIDAD DE CUENTA</span><h1>Actualiza tu contraseña.</h1><p>Define una nueva contraseña para volver a entrar al panel de tu farmacia.</p></div>
        <div className="auth-aside-footer">Panel privado para personal autorizado</div>
      </div>
      <main className="auth-main">
        <div className="auth-form-wrap recovery-card">
          <span className="section-kicker">RESTABLECER ACCESO</span>
          <h2>Nueva contraseña</h2>
          <p className="auth-copy">Usa una contraseña segura que no hayas utilizado antes.</p>
          {error && <div className="inline-alert error-alert" role="alert" aria-live="assertive">{error}</div>}
          <form onSubmit={submit} className="auth-form" aria-busy={submitting}>
            <Field label="Nueva contraseña" required id="recovery-password"><div className="auth-input-shell"><span className="auth-input-icon"><LockIcon /></span><input id="recovery-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Escribe una contraseña segura" autoComplete="new-password" minLength="8" required /></div></Field>
            <Field label="Repite la contraseña" required id="recovery-confirmation"><div className="auth-input-shell"><span className="auth-input-icon"><LockIcon /></span><input id="recovery-confirmation" type="password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} placeholder="Repite tu contraseña" autoComplete="new-password" required /></div></Field>
            <button type="submit" className="primary-button full-width" disabled={submitting}>{submitting ? 'Actualizando…' : 'Guardar contraseña'} <ArrowIcon /></button>
          </form>
          <div className="auth-note"><ShieldIcon /><span>Acceso seguro para personal autorizado</span></div>
        </div>
      </main>
    </div>
  );
}

function MandatoryPasswordScreen({ profile }) {
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const submit = async (event) => {
    event.preventDefault();
    setError('');
    if (password.length < 8) {
      setError('La nueva contraseña debe tener al menos 8 caracteres.');
      return;
    }
    if (password !== confirmation) {
      setError('Las contraseñas no coinciden.');
      return;
    }
    setSubmitting(true);
    const { error: updateError } = await supabase.auth.updateUser({ password });
    if (!updateError) {
      const { error: flagError } = await supabase.rpc('complete_password_change');
      if (flagError) setError(getErrorMessage(flagError));
      else window.location.reload();
    } else {
      setError('No se pudo actualizar la contraseña. Inténtalo nuevamente.');
    }
    setSubmitting(false);
  };

  return <div className="auth-page recovery-page"><div className="auth-aside recovery-aside"><div className="brand-lockup"><BrandLogo inverse /></div><div className="recovery-copy"><span className="section-kicker">SEGURIDAD DE CUENTA</span><h1>Cambia tu contraseña.</h1><p>La contraseña entregada por el administrador es temporal.</p></div><div className="auth-aside-footer">Panel privado para personal autorizado</div></div><main className="auth-main"><div className="auth-form-wrap recovery-card"><span className="section-kicker">PRIMER ACCESO</span><h2>Actualiza tu contraseña</h2><p className="auth-copy">{profile?.full_name || 'Usuario'}, define una contraseña personal para continuar.</p>{error && <div className="inline-alert error-alert" role="alert">{error}</div>}<form onSubmit={submit} className="auth-form" aria-busy={submitting}><Field label="Nueva contraseña" required id="mandatory-password"><div className="auth-input-shell"><span className="auth-input-icon"><LockIcon /></span><input id="mandatory-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Escribe una contraseña segura" autoComplete="new-password" minLength="8" required /></div></Field><Field label="Repite la contraseña" required id="mandatory-password-confirm"><div className="auth-input-shell"><span className="auth-input-icon"><LockIcon /></span><input id="mandatory-password-confirm" type="password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} placeholder="Repite tu contraseña" autoComplete="new-password" required /></div></Field><button className="primary-button full-width" disabled={submitting}>{submitting ? 'Guardando…' : 'Guardar y continuar'} <ArrowIcon /></button></form><div className="auth-note"><ShieldIcon /><span>La contraseña temporal dejará de funcionar después de este cambio.</span></div></div></main></div>;
}

function LoginScreen() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const atmosphereOrbitRef = useRef(null);
  const atmosphereGlowRef = useRef(null);
  const atmosphereFrameRef = useRef(null);
  const atmospherePointerRef = useRef({ x: 0, y: 0 });

  const moveAtmosphere = (event) => {
    const card = event.currentTarget;
    const bounds = card.getBoundingClientRect();
    atmospherePointerRef.current = {
      x: ((event.clientX - bounds.left) / bounds.width - 0.5) * 2,
      y: ((event.clientY - bounds.top) / bounds.height - 0.5) * 2,
    };
    if (atmosphereFrameRef.current !== null) return;
    atmosphereFrameRef.current = window.requestAnimationFrame(() => {
      atmosphereFrameRef.current = null;
      const { x, y } = atmospherePointerRef.current;
      if (atmosphereOrbitRef.current) {
        atmosphereOrbitRef.current.style.transform = `translate3d(${x * 14}px, ${y * 10}px, 0)`;
      }
      if (atmosphereGlowRef.current) {
        atmosphereGlowRef.current.style.transform = `translate3d(${x * -10}px, ${y * -8}px, 0)`;
      }
    });
  };

  const resetAtmosphere = () => {
    if (atmosphereFrameRef.current !== null) {
      window.cancelAnimationFrame(atmosphereFrameRef.current);
      atmosphereFrameRef.current = null;
    }
    if (atmosphereOrbitRef.current) atmosphereOrbitRef.current.style.transform = 'translate3d(0, 0, 0)';
    if (atmosphereGlowRef.current) atmosphereGlowRef.current.style.transform = 'translate3d(0, 0, 0)';
  };

  useEffect(() => () => resetAtmosphere(), []);

  const submit = async (event) => {
    event.preventDefault();
    setSubmitting(true);
    setError('');
    const { error: signInError } = await supabase.auth.signInWithPassword({ email: normalizeAuthIdentifier(email), password });
    if (signInError) setError(getErrorMessage(signInError));
    setSubmitting(false);
  };

  return (
    <div className="auth-page">
      <div className="auth-aside">
        <div className="brand-lockup"><BrandLogo inverse /></div>
        <div className="auth-quote">
          <LoginHeroCopy />
        </div>
        <div className="auth-aside-footer">Panel privado para personal autorizado</div>
      </div>
      <main className="auth-main">
        <div className="auth-form-wrap" onPointerMove={moveAtmosphere} onPointerLeave={resetAtmosphere}>
          <LoginFormAtmosphere orbitRef={atmosphereOrbitRef} glowRef={atmosphereGlowRef} />
          <span className="section-kicker">Acceso de farmacia</span>
          <h2>Inicia sesión</h2>
          <p className="auth-copy">Usa el usuario que el administrador creó para tu farmacia.</p>
          {error && <div className="inline-alert error-alert" role="alert">{error}</div>}
          <form onSubmit={submit} className="auth-form" aria-busy={submitting}>
            <Field label="Usuario o correo" required>
              <input type="text" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="juan.perez" autoComplete="username" required />
            </Field>
            <Field label="Contraseña" required>
              <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="••••••••" autoComplete="current-password" required />
            </Field>
            <button className="primary-button full-width" disabled={submitting}>{submitting ? 'Validando…' : 'Entrar al panel'} <span>→</span></button>
          </form>
          <div className="auth-note"><span>●</span> Autenticación protegida por Supabase Auth</div>
        </div>
      </main>
    </div>
  );
}

function PharmacyProfileChooser({ pharmacy, profiles, onSelect, onSignOut }) {
  return (
    <div className="profile-gate">
      <div className="profile-gate-card">
        <BrandLogo />
        <span className="section-kicker">PERFIL OPERATIVO</span>
        <h1>¿Quién va a publicar?</h1>
        <p>Selecciona el vendedor o cajero de <strong>{formatPharmacyDisplay(pharmacy)}</strong>. Los domicilios quedarán registrados a su nombre.</p>
        <div className="profile-choice-list">
          {profiles.map((item) => (
            <button type="button" className="profile-choice" key={item.id} onClick={() => onSelect(item)}>
              <span className="profile-choice-avatar">{(item.display_name || 'P').slice(0, 1).toUpperCase()}</span>
              <span className="profile-choice-copy"><strong>{item.display_name}</strong><small>{item.profile_role === 'cajero' ? 'Cajero' : 'Vendedor'} · {item.username}</small></span>
              <span className="profile-choice-arrow">→</span>
            </button>
          ))}
        </div>
        <button type="button" className="sign-out-link profile-gate-signout" onClick={onSignOut}>Cerrar sesión <span>↗</span></button>
      </div>
    </div>
  );
}

function PurchaseTaskRow({ item, index, canRemove, onChange, onRemove }) {
  return (
    <fieldset className="task-row">
      <legend>Compra {index + 1}</legend>
      <div className="task-row-grid purchase-task-grid">
        <label className="field"><span>Lugar o comercio <em>*</em></span><input value={item.merchant} onChange={(event) => onChange('merchant', event.target.value)} placeholder="Ej. Cruz Verde" /></label>
        <label className="field"><span>Sede o barrio <em>*</em></span><input value={item.branch} onChange={(event) => onChange('branch', event.target.value)} placeholder="Ej. Pradera" /></label>
        <label className="field"><span>Producto <em>*</em></span><input value={item.product} onChange={(event) => onChange('product', event.target.value)} placeholder="Nombre del producto" /></label>
        <label className="field quantity-field"><span>Cantidad <em>*</em></span><input type="number" min="1" step="1" value={item.quantity} onChange={(event) => onChange('quantity', event.target.value)} inputMode="numeric" /></label>
        <label className="field task-row-wide"><span>Instrucción de compra</span><input value={item.notes} onChange={(event) => onChange('notes', event.target.value)} placeholder="Referencia, presentación o detalle para identificarlo" /></label>
      </div>
      {canRemove && <button type="button" className="task-remove-button" onClick={onRemove} aria-label={`Eliminar compra ${index + 1}`}>Eliminar compra</button>}
    </fieldset>
  );
}

function CrossTaskRow({ stop, index, canRemove, availablePharmacies, onChange, onRemove }) {
  return (
    <fieldset className="task-row">
      <legend>Cruce {index + 1}</legend>
      <p className="task-helper">Origen es donde se recoge el producto; destino es la farmacia a la que se lleva.</p>
      <div className="task-row-grid cross-task-grid">
        <label className="field"><span>Farmacia de origen <em>*</em></span><select value={stop.originPharmacyCode} onChange={(event) => onChange('originPharmacyCode', event.target.value)}><option value="">Selecciona origen</option>{availablePharmacies.map((item) => <option key={`origin-${item.code}`} value={item.code}>{formatPharmacyOption(item)}</option>)}</select></label>
        <label className="field"><span>Farmacia destino <em>*</em></span><select value={stop.destinationPharmacyCode} onChange={(event) => onChange('destinationPharmacyCode', event.target.value)}><option value="">Selecciona destino</option>{availablePharmacies.map((item) => <option key={`destination-${item.code}`} value={item.code}>{formatPharmacyOption(item)}</option>)}</select></label>
        <label className="field"><span>Producto <em>*</em></span><input value={stop.product} onChange={(event) => onChange('product', event.target.value)} placeholder="Producto del cruce" /></label>
        <label className="field quantity-field"><span>Cantidad <em>*</em></span><input type="number" min="1" step="1" value={stop.quantity} onChange={(event) => onChange('quantity', event.target.value)} inputMode="numeric" /></label>
        <div className="task-assignee-hint task-row-wide"><span>Quién recoge</span><strong>El domiciliario que acepte la operación</strong></div>
        <label className="field task-row-wide"><span>Indicaciones del cruce</span><input value={stop.notes} onChange={(event) => onChange('notes', event.target.value)} placeholder="Ej. recoger el producto y llevarlo directamente al destino" /></label>
      </div>
      {canRemove && <button type="button" className="task-remove-button" onClick={onRemove} aria-label={`Eliminar cruce ${index + 1}`}>Eliminar cruce</button>}
    </fieldset>
  );
}

function App() {
  const [session, setSession] = useState(null);
  const [recoveryMode, setRecoveryMode] = useState(() => new URLSearchParams(window.location.search).get('mode') === 'reset-password');
  const [profile, setProfile] = useState(null);
  const [pharmacyProfiles, setPharmacyProfiles] = useState([]);
  const [selectedPharmacyProfile, setSelectedPharmacyProfile] = useState(null);
  const [pharmacy, setPharmacy] = useState(null);
  const [availablePharmacies, setAvailablePharmacies] = useState([]);
  const [zone, setZone] = useState(null);
  const [zoneCouriers, setZoneCouriers] = useState([]);
  const [weeklyZoneCouriers, setWeeklyZoneCouriers] = useState([]);
  const [deliveries, setDeliveries] = useState([]);
  const [customerMatches, setCustomerMatches] = useState([]);
  const [customerAddresses, setCustomerAddresses] = useState([]);
  const [selectedCustomerId, setSelectedCustomerId] = useState('');
  const [customerLookupLoading, setCustomerLookupLoading] = useState(false);
  const [courierBreakdown, setCourierBreakdown] = useState([]);
  const [courierDeliveryDetails, setCourierDeliveryDetails] = useState([]);
  const [courierBreakdownError, setCourierBreakdownError] = useState('');
  const [courierBreakdownLoading, setCourierBreakdownLoading] = useState(false);
  const [loading, setLoading] = useState(Boolean(supabase));
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [activeView, setActiveView] = useState('publish');
  const [chatDeliveryId, setChatDeliveryId] = useState(null);
  const [equivalentDeliveryId, setEquivalentDeliveryId] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [publishing, setPublishing] = useState(false);
  const [webPushState, setWebPushState] = useState(getInitialWebPushState);

  useEffect(() => {
    void registerWebAppServiceWorker().catch((serviceWorkerError) => {
      console.warn('No se pudo preparar la PWA:', serviceWorkerError?.message || serviceWorkerError);
    });
  }, []);

  useEffect(() => {
    if (!supabase) {
      setLoading(false);
      return undefined;
    }

    let mounted = true;
    let channel;
    let lastUserId = null;
    let loadRequest = 0;
    let courierRefreshInterval = null;
    let courierRefreshTimeout = null;

    const clearCourierRefresh = () => {
      if (courierRefreshInterval !== null) {
        window.clearInterval(courierRefreshInterval);
        courierRefreshInterval = null;
      }
      if (courierRefreshTimeout !== null) {
        window.clearTimeout(courierRefreshTimeout);
        courierRefreshTimeout = null;
      }
    };

    const clearWorkspace = () => {
      setProfile(null);
      setPharmacyProfiles([]);
      setSelectedPharmacyProfile(null);
      setPharmacy(null);
      setAvailablePharmacies([]);
      setZone(null);
      setZoneCouriers([]);
      setWeeklyZoneCouriers([]);
      setDeliveries([]);
      setCustomerMatches([]);
      setCustomerAddresses([]);
      setSelectedCustomerId('');
      setCourierBreakdown([]);
      setCourierDeliveryDetails([]);
      setCourierBreakdownError('');
      setCourierBreakdownLoading(false);
      setChatDeliveryId(null);
      setEquivalentDeliveryId(null);
    };

    const loadWorkspace = async (userId) => {
      const requestId = ++loadRequest;
      const isCurrent = () => mounted && requestId === loadRequest;
      setLoading(true);
      setError('');
      clearWorkspace();

      const { data: profileData, error: profileError } = await supabase
        .from('profiles')
        .select('id, full_name, role, pharmacy_code, phone, active, must_change_password')
        .eq('id', userId)
        .maybeSingle();

      if (!isCurrent()) return;
      if (profileError) {
        setError(getErrorMessage(profileError));
        setLoading(false);
        return;
      }
      if (!profileData) {
        setError('Tu usuario está autenticado, pero todavía no tiene perfil operativo.');
        setLoading(false);
        return;
      }
      setProfile(profileData);

      if (profileData.must_change_password) {
        setLoading(false);
        return;
      }

      if (!profileData.active) {
        setError('Este usuario está inactivo. Contacta al administrador.');
        setLoading(false);
        return;
      }
      void registerWebPushSubscription(userId).then((pushState) => {
        if (isCurrent()) setWebPushState(pushState);
      });
      if (profileData.role !== 'pharmacy') {
        setError(`Esta página es para usuarios de farmacia. Tu rol actual es ${profileData.role}.`);
        setLoading(false);
        return;
      }
      if (!profileData.pharmacy_code) {
        setError('Tu usuario todavía no tiene una farmacia asignada.');
        setLoading(false);
        return;
      }

      // Estos datos son independientes. Hacer las dos lecturas en paralelo
      // evita que el acceso espere dos viajes consecutivos a Supabase.
      const [pharmacyProfilesResponse, pharmacyResponse] = await Promise.all([
        supabase
          .from('pharmacy_profiles')
          .select('id, pharmacy_code, display_name, username, profile_role, active')
          .eq('pharmacy_code', profileData.pharmacy_code)
          .eq('active', true)
          .order('display_name'),
        supabase
          .from('pharmacies')
          .select('code, name, zone_name, address, active')
          .eq('code', profileData.pharmacy_code)
          .maybeSingle(),
      ]);

      if (!isCurrent()) return;
      const { data: pharmacyProfileData, error: pharmacyProfilesError } = pharmacyProfilesResponse;
      if (pharmacyProfilesError) {
        setError(getErrorMessage(pharmacyProfilesError));
        setLoading(false);
        return;
      }
      const activePharmacyProfiles = pharmacyProfileData ?? [];
      setPharmacyProfiles(activePharmacyProfiles);
      const rememberedProfileId = window.localStorage.getItem(
        `farmanorte.pharmacy-profile.${profileData.pharmacy_code}`,
      );
      const rememberedProfile = activePharmacyProfiles.find(
        (item) => item.id === rememberedProfileId,
      );
      setSelectedPharmacyProfile(
        rememberedProfile ?? (activePharmacyProfiles.length === 1 ? activePharmacyProfiles[0] : null),
      );

      const { data: pharmacyData, error: pharmacyError } = pharmacyResponse;
      if (pharmacyError) {
        setError(getErrorMessage(pharmacyError));
        setLoading(false);
        return;
      }
      if (!pharmacyData || !pharmacyData.active) {
        setError('La farmacia asignada no existe o está inactiva.');
        setLoading(false);
        return;
      }
      setPharmacy(pharmacyData);

      const loadCourierBreakdown = async (pharmacyCode) => {
        setCourierBreakdownLoading(true);
        try {
          const [breakdownResponse, detailResponse] = await Promise.all([
            supabase.rpc(
              'get_pharmacy_courier_breakdown',
              { requested_pharmacy_code: pharmacyCode },
            ),
            supabase.rpc(
              'get_pharmacy_courier_deliveries',
              { requested_pharmacy_code: pharmacyCode },
            ),
          ]);
          if (!isCurrent()) return;
          const responseError = breakdownResponse.error || detailResponse.error;
          if (responseError) {
            setCourierBreakdown([]);
            setCourierDeliveryDetails([]);
            setCourierBreakdownError(getErrorMessage(responseError));
            return;
          }
          setCourierBreakdown(breakdownResponse.data ?? []);
          setCourierDeliveryDetails(detailResponse.data ?? []);
          setCourierBreakdownError('');
        } catch (reportError) {
          if (!isCurrent()) return;
          setCourierBreakdown([]);
          setCourierDeliveryDetails([]);
          setCourierBreakdownError(getErrorMessage(reportError));
        } finally {
          if (isCurrent()) setCourierBreakdownLoading(false);
        }
      };

      // El catálogo solo se usa al elegir un cruce/compra. No debe bloquear la
      // apertura del panel principal.
      void supabase
        .from('pharmacies')
        .select('code, name, zone_name, active')
        .eq('active', true)
        .order('code')
        .then(({ data: pharmacyCatalog, error: pharmacyCatalogError }) => {
          if (!isCurrent()) return;
          setAvailablePharmacies(pharmacyCatalogError ? [] : (pharmacyCatalog ?? []));
        });

      const { data: directZone, error: directZoneError } = await supabase
        .from('zones')
        .select('id, name, active')
        .eq('name', pharmacyData.zone_name)
        .eq('active', true)
        .maybeSingle();

      if (!isCurrent()) return;
      if (directZoneError) {
        setError(getErrorMessage(directZoneError));
        setLoading(false);
        return;
      }
      setZone(directZone ?? null);

      const loadZoneCouriers = async () => {
        if (!directZone?.id) {
          setZoneCouriers([]);
          setWeeklyZoneCouriers([]);
          return;
        }
        // Solo los turnos del día: se recalcula en cada refresco, así que al
        // pasar la medianoche desaparecen los del día anterior.
        const currentDate = localDateIso();
        const todayResponse = await supabase.rpc(
          'get_pharmacy_zone_couriers',
          { requested_zone_id: directZone.id, requested_date: currentDate },
        );
        if (!isCurrent()) return;
        if (todayResponse.error) {
          setZoneCouriers([]);
          setWeeklyZoneCouriers([]);
          setError(getErrorMessage(todayResponse.error));
          return;
        }
        setZoneCouriers(todayResponse.data ?? []);
        setWeeklyZoneCouriers((todayResponse.data ?? [])
          .filter((row) => String(row.scheduled_for || currentDate).slice(0, 10) === currentDate));
      };

      // Estas consultas no dependen entre sí. Ejecutarlas en paralelo evita que
      // la pantalla espere primero la semana de turnos, el desglose y luego los
      // pedidos. El desglose continúa cargando en segundo plano.
      const zoneCouriersPromise = loadZoneCouriers();
      const deliveryPromise = supabase
        .from('deliveries')
        .select('*')
        .eq('pharmacy_code', pharmacyData.code)
        .order('created_at', { ascending: false })
        .limit(30);
      void loadCourierBreakdown(pharmacyData.code);

      const [, deliveryResponse] = await Promise.all([
        zoneCouriersPromise,
        deliveryPromise,
      ]);
      if (!isCurrent()) return;

      const scheduleZoneCourierRefresh = () => {
        if (!isCurrent() || courierRefreshTimeout !== null) return;
        courierRefreshTimeout = window.setTimeout(() => {
          courierRefreshTimeout = null;
          void loadZoneCouriers();
        }, 250);
      };

      clearCourierRefresh();
      courierRefreshInterval = window.setInterval(scheduleZoneCourierRefresh, 10000);

      const { data: deliveryData, error: deliveriesError } = deliveryResponse;

      if (!isCurrent()) return;
      if (deliveriesError) {
        setError(getErrorMessage(deliveriesError));
      } else {
        setDeliveries(deliveryData ?? []);
        const query = new URLSearchParams(window.location.search);
        const notificationDeliveryId = query.get('delivery');
        if (notificationDeliveryId && (deliveryData ?? []).some((item) => item.id === notificationDeliveryId)) {
          const opensChat = query.get('chat') === '1';
          setActiveView('history');
          setChatDeliveryId(opensChat ? notificationDeliveryId : null);
          setEquivalentDeliveryId(null);
          window.history.replaceState({}, '', window.location.pathname);
        }
      }
      setLoading(false);

      const knownDeliveryIds = new Set((deliveryData ?? []).map((item) => item.id));

      if (channel) {
        await supabase.removeChannel(channel);
        channel = null;
      }
      channel = supabase
        .channel(`pharmacy-deliveries-${pharmacyData.code}-${requestId}`)
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'deliveries',
            filter: `pharmacy_code=eq.${pharmacyData.code}`,
          },
          (payload) => {
            if (payload.eventType === 'INSERT') {
              knownDeliveryIds.add(payload.new.id);
              if (payload.new.status === 'offered') {
                playNotificationTone('delivery');
                setNotice(`Nuevo domicilio disponible: ${formatDeliveryPublicCode(payload.new.public_code) || payload.new.id?.slice(0, 8)}`);
              }
            }
            if (payload.eventType === 'DELETE') knownDeliveryIds.delete(payload.old.id);
            setDeliveries((current) => {
              if (payload.eventType === 'DELETE') {
                return current.filter((item) => item.id !== payload.old.id);
              }
              const next = current.filter((item) => item.id !== payload.new.id);
              return [payload.new, ...next].sort(
                (left, right) => new Date(right.created_at) - new Date(left.created_at),
              ).slice(0, 30);
            });
            void loadCourierBreakdown(pharmacyData.code);
          },
        )
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'delivery_equivalents',
            filter: `pharmacy_code=eq.${pharmacyData.code}`,
          },
          () => void loadCourierBreakdown(pharmacyData.code),
        )
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'delivery_chat_messages' },
          (payload) => {
            if (payload.new.sender_id === userId || !knownDeliveryIds.has(payload.new.delivery_id)) return;
            playNotificationTone('message');
            setActiveView('history');
            setEquivalentDeliveryId(null);
            setChatDeliveryId(payload.new.delivery_id);
            setNotice('Nuevo mensaje del domiciliario. El chat se abrió automáticamente.');
          },
        )
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'shifts' },
          scheduleZoneCourierRefresh,
        )
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'courier_presence' },
          scheduleZoneCourierRefresh,
        )
        .subscribe();
    };

    const applySession = (nextSession) => {
      if (!mounted) return;
      setSession(nextSession);
      if (!nextSession) {
        lastUserId = null;
        loadRequest += 1;
        clearCourierRefresh();
        clearWorkspace();
        setLoading(false);
        return;
      }
      if (lastUserId === nextSession.user.id) return;
      lastUserId = nextSession.user.id;
      void loadWorkspace(nextSession.user.id);
    };

    const loadSession = async () => {
      setLoading(true);
      setError('');
      const { data, error: sessionError } = await supabase.auth.getSession();
      if (!mounted) return;
      if (sessionError) {
        setError(getErrorMessage(sessionError));
        setLoading(false);
        return;
      }
      applySession(data.session ?? null);
    };

    const { data: authListener } = supabase.auth.onAuthStateChange((event, nextSession) => {
      if (event === 'PASSWORD_RECOVERY') setRecoveryMode(true);
      if (event === 'SIGNED_OUT') {
        setRecoveryMode(false);
        void deactivateWebPushSubscription(lastUserId);
        setWebPushState(getInitialWebPushState());
      }
      applySession(nextSession);
    });

    void loadSession();

    return () => {
      mounted = false;
      loadRequest += 1;
      clearCourierRefresh();
      authListener.subscription.unsubscribe();
      if (channel) supabase.removeChannel(channel);
    };
  }, []);

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return undefined;
    const handleServiceWorkerMessage = (event) => {
      if (event.data?.type !== 'farmanorte-pushsubscriptionchange' || !session?.user?.id) return;
      void registerWebPushSubscription(session.user.id).then(setWebPushState);
    };
    navigator.serviceWorker.addEventListener('message', handleServiceWorkerMessage);
    return () => navigator.serviceWorker.removeEventListener('message', handleServiceWorkerMessage);
  }, [session?.user?.id]);

  const signOut = async () => {
    if (!supabase) return;
    setError('');
    setNotice('');
    try {
      await deactivateWebPushSubscription(session?.user?.id);
      const { error: signOutError } = await supabase.auth.signOut();
      if (signOutError) {
        setError(`No se pudo cerrar sesión: ${getErrorMessage(signOutError)}`);
        return;
      }
      // El listener de Auth también limpia el estado, pero lo hacemos aquí
      // para que la pantalla cambie incluso si el evento llega con retraso.
      setSession(null);
      setProfile(null);
      setPharmacy(null);
      setPharmacyProfiles([]);
      setSelectedPharmacyProfile(null);
      setAvailablePharmacies([]);
      setZone(null);
      setZoneCouriers([]);
      setDeliveries([]);
      setCourierBreakdown([]);
      setCourierDeliveryDetails([]);
      setCourierBreakdownError('');
      setCourierBreakdownLoading(false);
      setChatDeliveryId(null);
      setEquivalentDeliveryId(null);
      setForm(createEmptyForm());
      setActiveView('publish');
      setWebPushState(getInitialWebPushState());
    } catch (signOutException) {
      setError(`No se pudo cerrar sesión: ${getErrorMessage(signOutException)}`);
    }
  };

  const enableWebPush = async () => {
    if (!session?.user?.id) return;
    setWebPushState((current) => ({ ...current, loading: true, error: '', message: '' }));
    const nextState = await registerWebPushSubscription(session.user.id, { requestPermission: true });
    setWebPushState(nextState);
    if (nextState.enabled) {
      setNotice(nextState.message);
    } else if (nextState.error) {
      setError(nextState.error);
    }
  };

  const disableWebPush = async () => {
    if (!session?.user?.id) return;
    setWebPushState((current) => ({ ...current, loading: true, error: '', message: '' }));
    const disabled = await deactivateWebPushSubscription(session.user.id);
    const capability = getWebPushCapability();
    setWebPushState({
      ...getInitialWebPushState(),
      ...capability,
      message: disabled ? 'Alertas desactivadas en este dispositivo.' : '',
      error: disabled ? '' : 'No se pudo desactivar la alerta. Inténtalo de nuevo.',
    });
  };

  const choosePharmacyProfile = (nextProfile) => {
    setSelectedPharmacyProfile(nextProfile);
    if (nextProfile?.id && pharmacy?.code) {
      window.localStorage.setItem(
        `farmanorte.pharmacy-profile.${pharmacy.code}`,
        nextProfile.id,
      );
    }
  };

  const assignDelivery = async (deliveryId, courierId) => {
    if (!supabase || !deliveryId || !courierId) return false;
    setError('');
    setNotice('');
    const { error: assignmentError } = await supabase.rpc('assign_delivery_to_courier', {
      requested_delivery_id: deliveryId,
      requested_courier_id: courierId,
    });
    if (assignmentError) {
      setError(getErrorMessage(assignmentError));
      return false;
    }
    triggerPushNotification({ event: 'delivery_assigned', delivery_id: deliveryId });
    setNotice('Domicilio asignado correctamente.');
    return true;
  };

  const loadDeliveryCouriers = async (deliveryId) => {
    if (!supabase || !deliveryId) {
      throw new Error('No hay una sesión activa para consultar la cobertura del recorrido.');
    }
    const { data, error: couriersError } = await supabase.rpc(
      'get_pharmacy_delivery_couriers',
      { requested_delivery_id: deliveryId, requested_date: localDateIso() },
    );
    if (couriersError) throw new Error(getErrorMessage(couriersError));
    return Array.isArray(data) ? data : [];
  };

  const respondToDeliveryApproval = async (deliveryId, approved) => {
    if (!supabase || !deliveryId) return false;
    setError('');
    setNotice('');
    const functionName = approved ? 'approve_delivery_request' : 'reject_delivery_request';
    const { error: approvalError } = await supabase.rpc(functionName, {
      requested_delivery_id: deliveryId,
    });
    if (approvalError) {
      setError(getErrorMessage(approvalError));
      return false;
    }
    setDeliveries((current) => current.map((item) => item.id === deliveryId
      ? { ...item, approval_pending: false, ...(approved ? { status: 'accepted' } : {}) }
      : item));
    setNotice(approved ? 'Segundo domicilio aprobado.' : 'Solicitud de segundo domicilio rechazada.');
    return true;
  };

  const selectedServiceType = getServiceTypeConfig(form.serviceType);
  const hasTaskDetails = Boolean(selectedServiceType.requiresPurchase || selectedServiceType.requiresCross);
  const requiresClient = Boolean(selectedServiceType.requiresClient);
  const requiresPayment = Boolean(selectedServiceType.requiresPayment);
  const detailsStep = hasTaskDetails ? String(requiresClient ? 3 : 2) : null;
  const paymentStep = requiresPayment ? String(hasTaskDetails ? 4 : 3) : null;
  const summaryStep = String(requiresPayment ? Number(paymentStep) + 1 : hasTaskDetails ? Number(detailsStep) + 1 : requiresClient ? 3 : 2);
  const taskSectionTitle = selectedServiceType.requiresPurchase && selectedServiceType.requiresCross
    ? 'Detalles de compra y cruce'
    : selectedServiceType.requiresPurchase
      ? 'Detalles de compra'
      : 'Detalles del cruce';
  const operationHelper = requiresClient && !hasTaskDetails
    ? 'La farmacia ya conoce los productos; completa solo cliente, dirección y pago.'
    : selectedServiceType.requiresPurchase && selectedServiceType.requiresCross
      ? 'Completa los datos de la compra y del cruce.'
      : selectedServiceType.requiresPurchase
        ? 'Completa los datos de la compra externa.'
        : 'Completa los datos del cruce entre farmacias.';
  const cashChange = form.paymentMethod === 'cash' && Number(form.paymentAmount) > 0 && Number(form.cashExpected) > 0
    ? Number(form.cashExpected) - Number(form.paymentAmount)
    : null;
  const pharmacyLabel = (code) => {
    const catalogItem = availablePharmacies.find((item) => item.code === code);
    return catalogItem ? formatPharmacyOption(catalogItem) : `FN ${code}`;
  };
  const crossPreview = form.crossStops
    .filter((stop) => stop.originPharmacyCode && stop.destinationPharmacyCode)
    .map((stop) => `${pharmacyLabel(stop.originPharmacyCode)} → ${pharmacyLabel(stop.destinationPharmacyCode)}`)
    .join(' · ');

  useEffect(() => {
    const phone = form.clientPhone.replace(/\D/g, '');
    if (!supabase || phone.length !== 10) {
      setCustomerMatches([]);
      setCustomerAddresses([]);
      setSelectedCustomerId('');
      return undefined;
    }
    let cancelled = false;
    setCustomerLookupLoading(true);
    const loadMatches = async () => {
      const { data, error: lookupError } = await supabase
        .from('customers')
        .select('id, first_name, last_name, phone')
        .eq('phone', phone)
        .eq('active', true)
        .order('created_at');
      if (cancelled) return;
      if (lookupError) {
        setCustomerMatches([]);
        setCustomerAddresses([]);
        setCustomerLookupLoading(false);
        return;
      }
      const matches = data ?? [];
      setCustomerMatches(matches);
      if (matches.length === 1) {
        const match = matches[0];
        setSelectedCustomerId(match.id);
        if (!form.clientName.trim()) {
          setForm((current) => ({
            ...current,
            clientName: `${match.first_name || ''} ${match.last_name || ''}`.trim(),
          }));
        }
        const { data: addresses } = await supabase
          .from('customer_addresses')
          .select('id, label, address, neighborhood, address_reference, is_default')
          .eq('customer_id', match.id)
          .eq('active', true)
          .order('is_default', { ascending: false });
        if (!cancelled) setCustomerAddresses(addresses ?? []);
      } else {
        setSelectedCustomerId('');
        setCustomerAddresses([]);
      }
      setCustomerLookupLoading(false);
    };
    void loadMatches();
    return () => { cancelled = true; };
  }, [form.clientPhone]);

  const chooseCustomer = async (customer) => {
    setSelectedCustomerId(customer.id);
    setForm((current) => ({
      ...current,
      clientName: `${customer.first_name || ''} ${customer.last_name || ''}`.trim(),
      address: '',
    }));
    const { data: addresses } = await supabase
      .from('customer_addresses')
      .select('id, label, address, neighborhood, address_reference, is_default')
      .eq('customer_id', customer.id)
      .eq('active', true)
      .order('is_default', { ascending: false });
    setCustomerAddresses(addresses ?? []);
  };

  const updateServiceType = (serviceType) => {
    const nextServiceType = getServiceTypeConfig(serviceType);
    setSelectedCustomerId('');
    setCustomerAddresses([]);
    setForm((current) => ({
      ...current,
      serviceType: nextServiceType.value,
      kind: nextServiceType.kind,
      clientName: nextServiceType.requiresClient ? current.clientName : '',
      clientPhone: nextServiceType.requiresClient ? current.clientPhone : '',
      address: nextServiceType.requiresClient ? current.address : '',
      paymentMethod: nextServiceType.requiresPayment ? current.paymentMethod : 'cash',
      paymentAmount: nextServiceType.requiresPayment ? current.paymentAmount : '',
      cashExpected: nextServiceType.requiresPayment ? current.cashExpected : '',
      purchaseItems: nextServiceType.requiresPurchase ? [createPurchaseItem()] : [],
      crossStops: nextServiceType.requiresCross ? [createCrossStop()] : [],
    }));
  };

  const updatePurchaseItem = (itemId, field, value) => {
    setForm((current) => ({
      ...current,
      purchaseItems: current.purchaseItems.map((item) => item.id === itemId ? { ...item, [field]: value } : item),
    }));
  };

  const addPurchaseItem = () => {
    setForm((current) => ({ ...current, purchaseItems: [...current.purchaseItems, createPurchaseItem()] }));
  };

  const removePurchaseItem = (itemId) => {
    setForm((current) => ({
      ...current,
      purchaseItems: current.purchaseItems.filter((item) => item.id !== itemId),
    }));
  };

  const updateCrossStop = (stopId, field, value) => {
    setForm((current) => ({
      ...current,
      crossStops: current.crossStops.map((stop) => stop.id === stopId ? { ...stop, [field]: value } : stop),
    }));
  };

  const addCrossStop = () => {
    if (form.crossStops.length >= 10) {
      setError('Un domicilio puede tener máximo 10 cruces.');
      return;
    }
    setForm((current) => ({ ...current, crossStops: [...current.crossStops, createCrossStop()] }));
  };

  const removeCrossStop = (stopId) => {
    setForm((current) => ({
      ...current,
      crossStops: current.crossStops.filter((stop) => stop.id !== stopId),
    }));
  };

  const publishDelivery = async (event) => {
    event.preventDefault();
    if (!supabase || !session || !profile || !pharmacy) return;
    if (!zone) {
      setError(`La farmacia no tiene una zona activa configurada (${pharmacy.zone_name}). El administrador debe configurarla antes de publicar.`);
      return;
    }

    if (requiresClient) {
      const requiredFields = [
        ['clientName', 'nombre del cliente'],
        ['clientPhone', 'teléfono del cliente'],
        ['address', 'dirección completa'],
      ];
      const missing = requiredFields.find(([key]) => !String(form[key]).trim());
      if (missing) {
        setError(`Completa el campo: ${missing[1]}.`);
        return;
      }
      const phoneDigits = form.clientPhone.replace(/\D/g, '');
      if (phoneDigits.length !== 10) {
        setError(`Número incompleto: te faltan ${Math.max(0, 10 - phoneDigits.length)} números.`);
        return;
      }
      if (!phoneDigits.startsWith('3')) {
        setError('El número debe empezar por 3 y tener exactamente 10 números en Colombia.');
        return;
      }
      if (form.address.trim().length < 8) {
        setError('Completa una dirección válida con barrio, nomenclatura o manzana y una referencia.');
        return;
      }
    }
    if (requiresPayment) {
      if (!Number(form.paymentAmount)) {
        setError('Indica el valor total del pedido.');
        return;
      }
      if (form.paymentMethod === 'cash' && !Number(form.cashExpected)) {
        setError('Indica con cuánto pagará el cliente en efectivo.');
        return;
      }
      if (form.paymentMethod === 'cash' && Number(form.cashExpected) < Number(form.paymentAmount)) {
        setError('El valor con el que paga el cliente no puede ser menor al total del pedido.');
        return;
      }
    }
    if (selectedServiceType.requiresPurchase) {
      const invalidPurchase = form.purchaseItems.find((item) => !item.merchant.trim() || !item.branch.trim() || !item.product.trim() || !Number(item.quantity));
      if (invalidPurchase) {
        setError('Completa comercio, sede, producto y cantidad en cada compra externa.');
        return;
      }
    }
    if (selectedServiceType.requiresCross) {
      if (form.crossStops.length === 0) {
        setError('Agrega al menos un cruce entre farmacias.');
        return;
      }
      const invalidCross = form.crossStops.find((stop) => !stop.originPharmacyCode || !stop.destinationPharmacyCode || stop.originPharmacyCode === stop.destinationPharmacyCode || !stop.product.trim() || !Number(stop.quantity));
      if (invalidCross) {
        setError('Completa origen, destino, producto y cantidad en cada cruce.');
        return;
      }
    }

    setPublishing(true);
    setError('');
    setNotice('');
    const productSummary = buildProductSummary(form);
    let customerId = null;
    let customerAddressId = null;
    if (requiresClient) {
      const { data: customerRows, error: customerError } = await supabase.rpc(
        'upsert_customer_contact',
        {
          requested_name: form.clientName.trim(),
          requested_phone: form.clientPhone.trim(),
          requested_address: form.address.trim(),
        },
      );
      if (customerError) {
        setError(`No se pudo guardar el cliente: ${getErrorMessage(customerError)}`);
        setPublishing(false);
        return;
      }
      const customerRow = Array.isArray(customerRows) ? customerRows[0] : customerRows;
      customerId = customerRow?.customer_id || null;
      customerAddressId = customerRow?.customer_address_id || null;
    }
    const deliveryTasks = buildDeliveryTasks(form);
    const routeLabel = form.crossStops.length > 0
      ? form.crossStops.map((stop) => `${pharmacyLabel(stop.originPharmacyCode)} → ${pharmacyLabel(stop.destinationPharmacyCode)}`).join(' · ')
      : form.purchaseItems.map((item) => `${item.merchant} · ${item.branch}`).join(' · ');
    const pickupStops = [
      ...(!selectedServiceType.requiresCross || selectedServiceType.requiresPurchase || requiresClient
        ? [{ task_type: 'pharmacy', pharmacy_code: pharmacy.code, label: pharmacy.name }]
        : []),
      ...form.crossStops.map((stop, index) => ({
        task_type: 'cross', sequence_no: index + 1, pharmacy_code: stop.originPharmacyCode,
        destination_pharmacy_code: stop.destinationPharmacyCode,
        label: `${stop.originPharmacyCode} → ${stop.destinationPharmacyCode}`,
      })),
      ...form.purchaseItems.map((item, index) => ({
        task_type: 'purchase', sequence_no: index + 1, merchant: item.merchant,
        branch: item.branch, label: `${item.merchant} · ${item.branch}`,
      })),
    ];

    const payload = {
      // Supabase asigna el consecutivo atómicamente por farmacia.
      public_code: null,
      pharmacy_code: pharmacy.code,
      zone_id: zone.id,
      kind: form.kind,
      service_type: form.serviceType,
      status: 'offered',
      client_name: requiresClient ? form.clientName.trim() : '',
      client_phone: requiresClient ? form.clientPhone.trim() : '',
      customer_id: customerId,
      customer_address_id: customerAddressId,
      neighborhood: requiresClient ? form.address.trim() : pharmacy.name,
      address: requiresClient ? form.address.trim() : routeLabel || `Operación interna de ${pharmacy.name}`,
      address_reference: requiresClient ? '' : 'Operación interna entre farmacias o compra externa.',
      notes: form.notes.trim() || null,
      product_summary: productSummary,
      payment_method: requiresPayment ? form.paymentMethod : 'none',
      payment_amount: requiresPayment ? Number(form.paymentAmount) || 0 : 0,
      cash_expected: requiresPayment && form.paymentMethod === 'cash' ? Number(form.cashExpected) : null,
      cash_change: requiresPayment && form.paymentMethod === 'cash' && cashChange >= 0 ? cashChange : null,
      total_to_collect: requiresPayment ? Number(form.paymentAmount) || 0 : 0,
      cross_count: form.crossStops.length,
      purchase_count: form.purchaseItems.length,
      change_of_money: false,
      has_dataphone: requiresPayment && ['card', 'qr'].includes(form.paymentMethod),
      pickup_stops: pickupStops,
      destination_options: requiresClient
        ? [{ type: 'client', label: form.address.trim() }]
        : form.crossStops.map((stop) => ({ type: 'pharmacy', label: pharmacyLabel(stop.destinationPharmacyCode) })),
      approval_pending: false,
      created_by: session.user.id,
      pharmacy_profile_id: selectedPharmacyProfile?.id ?? null,
      expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    };

    const { data, error: insertError } = await supabase
      .from('deliveries')
      .insert(payload)
      .select('*')
      .single();

    if (insertError) {
      setError(getErrorMessage(insertError));
      setPublishing(false);
      return;
    }

    if (deliveryTasks.length > 0) {
      const { error: taskError } = await supabase
        .from('delivery_tasks')
        .insert(deliveryTasks.map((task) => ({ ...task, delivery_id: data.id })));
      if (taskError) {
        setError(`El domicilio se creó, pero no se pudieron guardar sus pasos: ${getErrorMessage(taskError)}`);
        setPublishing(false);
        return;
      }
    }

    triggerPushNotification({ event: 'delivery_created', delivery_id: data.id });

    setForm(createEmptyForm());
    setActiveView('history');
    setPublishing(false);
    setNotice(`Domicilio ${formatDeliveryPublicCode(data.public_code)} publicado. La oferta vence en 5 minutos.`);
  };

  if (!supabase) return <ConfigScreen />;
  if (recoveryMode && session) return <PasswordRecoveryScreen onComplete={() => { setRecoveryMode(false); window.history.replaceState({}, '', window.location.pathname); }} />;
  if (!session) return <LoginScreen />;
  if (profile?.must_change_password) return <MandatoryPasswordScreen profile={profile} />;
  if (error && (!profile || profile.role !== 'pharmacy' || !pharmacy)) {
    return <AccessProblem error={error} onSignOut={signOut} />;
  }
  if (loading || !profile || !pharmacy) return <LoadingScreen />;
  if (pharmacyProfiles.length > 1 && !selectedPharmacyProfile) {
    return (
      <PharmacyProfileChooser
        pharmacy={pharmacy}
        profiles={pharmacyProfiles}
        onSelect={choosePharmacyProfile}
        onSignOut={signOut}
      />
    );
  }

  const assignedCouriers = [...new Map(
    zoneCouriers.map((courier) => [courier.courier_id, courier]),
  ).values()];
  const operatorName = selectedPharmacyProfile?.display_name || profile.full_name;
  const firstName = (operatorName || 'equipo').trim().split(/\s+/)[0];
  const operatorProfile = selectedPharmacyProfile
    ? { ...profile, full_name: selectedPharmacyProfile.display_name }
    : profile;
  const selectChatDelivery = (deliveryId) => {
    setChatDeliveryId(deliveryId);
    if (deliveryId) setEquivalentDeliveryId(null);
  };
  const selectEquivalentDelivery = (deliveryId) => {
    setEquivalentDeliveryId(deliveryId);
    if (deliveryId) setChatDeliveryId(null);
  };
  const openReportedEquivalent = (deliveryId) => {
    selectEquivalentDelivery(deliveryId);
    setActiveView('reception');
  };
  const openReportDetails = () => setActiveView('reception');

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-lockup">
          <BrandLogo />
        </div>

        <div className="sidebar-section-label">Módulo farmacia</div>
        <nav className="main-nav" aria-label="Navegación principal">
          <button type="button" className={activeView === 'publish' ? 'nav-item active' : 'nav-item'} onClick={() => setActiveView('publish')} aria-current={activeView === 'publish' ? 'page' : undefined}>
            <span className="nav-icon"><NavIcon name="publish" /></span>
            <span>Publicar domicilio</span>
          </button>
          <button type="button" className={activeView === 'history' ? 'nav-item active' : 'nav-item'} onClick={() => setActiveView('history')} aria-current={activeView === 'history' ? 'page' : undefined}>
            <span className="nav-icon"><NavIcon name="orders" /></span>
            <span>Pedidos</span>
            <span className="nav-count">{deliveries.length}</span>
          </button>
          <button type="button" className={activeView === 'reception' ? 'nav-item active' : 'nav-item'} onClick={() => setActiveView('reception')} aria-current={activeView === 'reception' ? 'page' : undefined}>
            <span className="nav-icon"><NavIcon name="reception" /></span>
            <span>Recepción</span>
          </button>
          <button type="button" className={activeView === 'schedule' ? 'nav-item active' : 'nav-item'} onClick={() => setActiveView('schedule')} aria-current={activeView === 'schedule' ? 'page' : undefined}>
            <span className="nav-icon"><NavIcon name="schedule" /></span>
            <span>Turnos</span>
          </button>
          <button type="button" className={activeView === 'settings' ? 'nav-item active' : 'nav-item'} onClick={() => setActiveView('settings')} aria-current={activeView === 'settings' ? 'page' : undefined}>
            <span className="nav-icon"><NavIcon name="settings" /></span>
            <span>Ajustes</span>
          </button>
        </nav>

        <div className="sidebar-bottom">
          <button type="button" className="sign-out-link" onClick={signOut}>Cerrar sesión <span>↗</span></button>
          <div className="connection-card">
            <span className="pulse-dot" />
            <div>
              <strong>Supabase conectado</strong>
              <span>Datos reales en tiempo real</span>
            </div>
          </div>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div>
            <p className="welcome-line">Bienvenido, {firstName}</p>
            <p className="eyebrow">Panel de farmacia <span className="live-pill">EN VIVO</span></p>
            <h1>{activeView === 'publish' ? 'Nuevo domicilio' : activeView === 'history' ? 'Pedidos' : activeView === 'reception' ? 'Recepción' : activeView === 'schedule' ? 'Turnos de la semana' : 'Ajustes'}</h1>
          </div>
          <div className="operator-info">
            <div className="operator-avatar">{(operatorName || 'F').slice(0, 1).toUpperCase()}</div>
            <div>
              <strong>{operatorName}</strong>
              {pharmacyProfiles.length > 1 ? (
                <label className="profile-switcher">
                  <span>Perfil activo</span>
                  <select
                    value={selectedPharmacyProfile?.id || ''}
                    onChange={(event) => choosePharmacyProfile(pharmacyProfiles.find((item) => item.id === event.target.value) || null)}
                    aria-label="Perfil activo de la farmacia"
                  >
                    {pharmacyProfiles.map((item) => <option key={item.id} value={item.id}>{item.display_name} · {item.profile_role === 'cajero' ? 'Cajero' : 'Vendedor'}</option>)}
                  </select>
                </label>
              ) : <span>{formatPharmacyDisplay(pharmacy)}</span>}
            </div>
          </div>
        </header>

        {error && <div className="inline-alert error-alert" role="alert">{error}<button type="button" aria-label="Cerrar error" onClick={() => setError('')}>×</button></div>}
        {notice && <div className="inline-alert success-alert" role="status">{notice}<button type="button" aria-label="Cerrar aviso" onClick={() => setNotice('')}>×</button></div>}

        {activeView === 'publish' ? (
          <div className="workspace-grid">
            <section className="form-card">
              <div className="card-heading">
                <div>
                  <span className="section-kicker">Salida inmediata</span>
                  <h2>Datos del domicilio</h2>
                </div>
                <div className="zone-chip"><span /> Zona {pharmacy.zone_name}</div>
              </div>

              <form onSubmit={publishDelivery}>
                <div className="form-section operation-section">
                  <div className="form-section-title"><span>01</span><div><strong>¿Qué necesitas gestionar?</strong><small>Elige la operación para mostrar solo los datos necesarios.</small></div></div>
                  <div className="operation-picker field">
                    <span>Tipo de operación <em> *</em></span>
                    <div className="service-type-grid" role="group" aria-label="Tipo de operación">
                      {SERVICE_TYPES.map((service) => <button type="button" key={service.value} className={form.serviceType === service.value ? 'service-type-choice active' : 'service-type-choice'} aria-pressed={form.serviceType === service.value} onClick={() => updateServiceType(service.value)}><strong>{service.label}</strong><small>{service.description}</small></button>)}
                    </div>
                    <p className="operation-helper">{selectedServiceType.description} {operationHelper}</p>
                  </div>
                </div>

                {requiresClient && <div className="form-section">
                  <div className="form-section-title"><span>02</span><div><strong>Cliente y ubicación</strong><small>Solo necesitamos nombre, teléfono y dirección completa.</small></div></div>
                  <div className="field-grid three-columns customer-fields">
                    <Field label="Nombre del cliente" required><input value={form.clientName} onChange={(event) => setForm({ ...form, clientName: event.target.value })} placeholder="Nombre completo" autoComplete="name" /></Field>
                    <Field label="Teléfono" required><input value={form.clientPhone} onChange={(event) => setForm({ ...form, clientPhone: event.target.value.replace(/\D/g, '').slice(0, 10) })} placeholder="3000000000" inputMode="numeric" maxLength={10} autoComplete="tel" aria-describedby="client-phone-help" aria-invalid={Boolean(form.clientPhone && (form.clientPhone.length !== 10 || !form.clientPhone.startsWith('3')))} /><small id="client-phone-help" className="field-help">{form.clientPhone ? form.clientPhone.length !== 10 ? `Número incompleto: te faltan ${10 - form.clientPhone.length}.` : form.clientPhone.startsWith('3') ? 'Número completo.' : 'Debe empezar por 3.' : 'Debe empezar por 3 y tener exactamente 10 números.'}</small>{customerLookupLoading && <small className="field-help">Buscando cliente registrado…</small>}{customerMatches.length > 1 && <div className="customer-picker"><span>Este teléfono tiene varios clientes</span>{customerMatches.map((customer) => <button type="button" key={customer.id} className={selectedCustomerId === customer.id ? 'customer-choice active' : 'customer-choice'} onClick={() => chooseCustomer(customer)}>{`${customer.first_name || ''} ${customer.last_name || ''}`.trim() || 'Cliente registrado'}</button>)}</div>}{selectedCustomerId && customerAddresses.length > 0 && <label className="saved-address-picker"><span>Dirección guardada</span><select value={form.address} onChange={(event) => setForm({ ...form, address: event.target.value })}><option value="">Selecciona una dirección</option>{customerAddresses.map((address) => <option key={address.id} value={address.address}>{address.label || address.address}</option>)}</select></label>}</Field>
                    <Field label="Dirección completa" required><textarea className="address-field" value={form.address} onChange={(event) => setForm({ ...form, address: event.target.value })} placeholder="Barrio, manzana/calle/carrera y referencia de llegada" rows="2" autoComplete="street-address" aria-describedby="address-help" aria-invalid={Boolean(form.address && form.address.trim().length < 8)} /><small id="address-help" className="field-help">{form.address ? form.address.trim().length < 8 ? 'Dirección incompleta: agrega barrio y referencia.' : 'Dirección lista para publicar.' : 'Incluye barrio, nomenclatura o manzana y una referencia.'}</small></Field>
                  </div>
                </div>}

                {hasTaskDetails && <div className="form-section">
                    <div className="form-section-title"><span>{detailsStep}</span><div><strong>{taskSectionTitle}</strong><small>Agrega una fila independiente por cada gestión adicional.</small></div></div>
                    {selectedServiceType.requiresPurchase && <div className="task-block">
                      <div className="task-block-header"><div><strong>Compras externas</strong><small>El domiciliario comprará fuera de la red de farmacias.</small></div><span className="task-count">{form.purchaseItems.length}</span></div>
                      {form.purchaseItems.map((item, index) => <PurchaseTaskRow key={item.id} item={item} index={index} canRemove={form.purchaseItems.length > 1} onChange={(field, value) => updatePurchaseItem(item.id, field, value)} onRemove={() => removePurchaseItem(item.id)} />)}
                      <button type="button" className="secondary-button task-add-button" onClick={addPurchaseItem}>＋ Agregar compra</button>
                    </div>}
                    {selectedServiceType.requiresCross && <div className="task-block">
                      <div className="task-block-header"><div><strong>Cruces entre farmacias</strong><small>Origen es donde se recoge; destino es donde se entrega el producto.</small></div><span className="task-count">{form.crossStops.length}/10</span></div>
                      {form.crossStops.map((stop, index) => <CrossTaskRow key={stop.id} stop={stop} index={index} canRemove={form.crossStops.length > 1} availablePharmacies={availablePharmacies} onChange={(field, value) => updateCrossStop(stop.id, field, value)} onRemove={() => removeCrossStop(stop.id)} />)}
                      <button type="button" className="secondary-button task-add-button" onClick={addCrossStop}>＋ Agregar cruce</button>
                    </div>}
                  </div>}

                {requiresPayment && <div className="form-section">
                  <div className="form-section-title"><span>{paymentStep}</span><div><strong>Forma de pago</strong><small>Transferencia queda agrupada como QR.</small></div></div>
                  <div className="payment-switcher" role="radiogroup" aria-label="Forma de pago">
                    {Object.entries(PAYMENT_LABELS).map(([value, label]) => <button type="button" key={value} aria-pressed={form.paymentMethod === value} className={form.paymentMethod === value ? 'payment-choice active' : 'payment-choice'} onClick={() => setForm({ ...form, paymentMethod: value })}><span className={`payment-symbol ${value}`} aria-hidden="true">{value === 'cash' ? '$' : value === 'card' ? '▣' : '⌁'}</span>{label}</button>)}
                  </div>
                  <div className="field-grid two-columns payment-fields">
                    <Field label="Valor total del pedido" required><input value={form.paymentAmount} onChange={(event) => setForm({ ...form, paymentAmount: event.target.value })} placeholder="$ 0" inputMode="decimal" /></Field>
                    {form.paymentMethod === 'cash' ? <Field label="Cliente paga con" required><input value={form.cashExpected} onChange={(event) => setForm({ ...form, cashExpected: event.target.value })} placeholder="$ 0" inputMode="decimal" /></Field> : <div className="payment-hint"><span>✓</span> Pago electrónico seleccionado.</div>}
                  </div>
                   {form.paymentMethod === 'cash' && <div className={cashChange === null ? 'cash-change-card pending' : cashChange < 0 ? 'cash-change-card insufficient' : 'cash-change-card'}><div><span>Vuelto</span><strong>{cashChange === null ? 'Pendiente' : cashChange < 0 ? 'Valor insuficiente' : formatMoney(cashChange)}</strong></div><small>{cashChange === null ? 'Completa el total y el valor recibido.' : cashChange < 0 ? `Faltan ${formatMoney(Math.abs(cashChange))} para completar el pedido.` : 'El sistema calcula el vuelto automáticamente.'}</small></div>}
                </div>}

                <div className="form-section last-section summary-section">
                  <div className="form-section-title"><span>{summaryStep}</span><div><strong>Resumen antes de publicar</strong><small>Verifica los datos antes de enviar la oferta.</small></div></div>
                  <div className="request-summary">
                    <div><span>Operación</span><strong>{form.serviceType}</strong></div>
                    {requiresClient && <><div><span>Cliente</span><strong>{form.clientName || 'Sin nombre'}</strong><small>{form.clientPhone || 'Sin teléfono'}</small></div><div><span>Destino</span><strong>{form.address || 'Sin dirección'}</strong></div></>}
                    {selectedServiceType.requiresPurchase && <><div><span>Lugar de compra</span><strong>{form.purchaseItems[0]?.merchant || 'Sin comercio'}</strong></div><div><span>Sede o barrio</span><strong>{form.purchaseItems[0]?.branch || 'Sin sede'}</strong></div><div><span>Total de compras</span><strong>{form.purchaseItems.length}</strong></div></>}
                    {selectedServiceType.requiresCross && <div><span>Ruta del cruce</span><strong>{crossPreview || 'Sin ruta'}</strong><small>Total de cruces: {form.crossStops.length}</small></div>}
                    {requiresPayment && <div><span>Pago</span><strong>{PAYMENT_LABELS[form.paymentMethod]} · {form.paymentAmount ? formatMoney(form.paymentAmount) : 'Sin total'}</strong>{form.paymentMethod === 'cash' && cashChange !== null && cashChange >= 0 && <small>Vuelto: {formatMoney(cashChange)}</small>}</div>}
                  </div>
                </div>

                <div className="form-actions"><span>La oferta quedará disponible durante 5 minutos.</span><button className="primary-button" disabled={publishing || !zone}>{publishing ? 'Publicando…' : 'Publicar domicilio'} <span>→</span></button></div>
              </form>
            </section>

            <aside className="side-column">
              <div className="info-card accent-card"><span className="card-icon">⌁</span><div><span className="section-kicker">Estado operativo</span><h3>{zone ? `Zona ${zone.name}` : 'Zona pendiente'}</h3><p>{zone ? 'Las ofertas serán visibles para domiciliarios conectados con esta zona asignada.' : 'Configura la zona en el panel administrador para habilitar publicaciones.'}</p></div></div>
              <div className="info-card zone-couriers-card">
                <div className="info-card-header">
                  <span className="section-kicker">Cobertura de hoy</span>
                  <span className="live-pill">{assignedCouriers.length} asignados</span>
                </div>
                <h3>{zone ? `Domiciliarios de ${zone.name}` : 'Domiciliarios de la zona'}</h3>
                {assignedCouriers.length > 0 ? (
                  <div className="zone-courier-list">
                    {assignedCouriers.map((courier) => (
                      <div className="zone-courier-row" key={courier.courier_id}>
                        <span className={courier.connected ? 'courier-avatar online' : 'courier-avatar'} aria-hidden="true">{(courier.full_name || 'D').slice(0, 1).toUpperCase()}</span>
                        <div className="zone-courier-main">
                          <strong>{courier.full_name || 'Domiciliario'}</strong>
                          <span>{courier.is_support ? 'Apoyo general · todas las zonas' : `${formatTime(courier.starts_at)}–${formatTime(courier.ends_at)} · ${courier.connected ? 'Conectado' : 'Programado'}`}</span>
                        </div>
                        {courier.phone ? <a className="zone-courier-phone" href={`tel:${courier.phone}`} aria-label={`Llamar a ${courier.full_name || 'domiciliario'}`}>{courier.phone}</a> : <span className="zone-courier-phone missing">Sin teléfono</span>}
                      </div>
                    ))}
                  </div>
                ) : <p className="empty-zone-couriers">No hay un domiciliario programado para esta zona hoy.</p>}
              </div>
              <WeeklyCourierSchedule rows={weeklyZoneCouriers} />
              <CourierBreakdownCard
                breakdown={courierBreakdown}
                deliveries={courierDeliveryDetails}
                error={courierBreakdownError}
                loading={courierBreakdownLoading}
                compact
                onOpenEquivalent={openReportedEquivalent}
                onViewDetails={openReportDetails}
              />
              <div className="info-card"><div className="info-card-header"><span className="section-kicker">Actividad reciente</span><button type="button" onClick={() => setActiveView('history')}>Ver todo →</button></div>{deliveries.slice(0, 3).map((delivery) => <DeliveryRow key={delivery.id} delivery={delivery} couriers={assignedCouriers} onLoadCouriers={loadDeliveryCouriers} onAssign={assignDelivery} onApproveDelivery={(deliveryId) => respondToDeliveryApproval(deliveryId, true)} onRejectDelivery={(deliveryId) => respondToDeliveryApproval(deliveryId, false)} onOpenChat={(deliveryId) => { selectChatDelivery(deliveryId); setActiveView('history'); }} onOpenEquivalent={(deliveryId) => { selectEquivalentDelivery(deliveryId); setActiveView('history'); }} />)}{deliveries.length === 0 && <EmptyActivity />}</div>
              <div className="process-card"><span className="section-kicker">Flujo registrado</span><div className="process-step"><span>1</span><div><strong>Publicas</strong><small>Oferta abierta por 5 min</small></div></div><div className="process-line" /><div className="process-step"><span>2</span><div><strong>Se acepta</strong><small>El domiciliario recibe el aviso</small></div></div><div className="process-line" /><div className="process-step"><span>3</span><div><strong>Se entrega</strong><small>El pedido queda registrado</small></div></div></div>
            </aside>
          </div>
        ) : activeView === 'schedule' ? (
          <PharmacyScheduleView
            pharmacy={pharmacy}
            rows={weeklyZoneCouriers}
            breakdown={courierBreakdown}
            breakdownError={courierBreakdownError}
            courierDeliveryDetails={courierDeliveryDetails}
            breakdownLoading={courierBreakdownLoading}
            onOpenEquivalent={openReportedEquivalent}
            onViewDetails={openReportDetails}
          />
        ) : activeView === 'settings' ? (
          <PharmacySettingsView
            pharmacy={pharmacy}
            profile={operatorProfile}
            profiles={pharmacyProfiles}
            webPushState={webPushState}
            onEnableWebPush={enableWebPush}
            onDisableWebPush={disableWebPush}
            onSignOut={signOut}
          />
        ) : (
          <HistoryView
            deliveries={deliveries}
            pharmacy={pharmacy}
            session={session}
            profile={operatorProfile}
            selectedChatDeliveryId={chatDeliveryId}
            onOpenChat={selectChatDelivery}
            selectedEquivalentDeliveryId={equivalentDeliveryId}
            onOpenEquivalent={selectEquivalentDelivery}
            couriers={assignedCouriers}
            onLoadCouriers={loadDeliveryCouriers}
            onAssign={assignDelivery}
            onApproveDelivery={(deliveryId) => respondToDeliveryApproval(deliveryId, true)}
            onRejectDelivery={(deliveryId) => respondToDeliveryApproval(deliveryId, false)}
            courierBreakdown={courierBreakdown}
            courierBreakdownError={courierBreakdownError}
            courierDeliveryDetails={courierDeliveryDetails}
            courierBreakdownLoading={courierBreakdownLoading}
            viewMode={activeView}
          />
        )}
      </main>
    </div>
  );
}

function Field({ label, required, id, children }) {
  const labelContent = label && <span>{label}{required && <em> *</em>}</span>;
  if (!id) return <label className="field">{labelContent}{children}</label>;
  return <div className="field"><label className="field-label" htmlFor={id}>{labelContent}</label>{children}</div>;
}

function DeliveryRow({ delivery, onOpenChat, onOpenEquivalent, couriers = [], onLoadCouriers, onAssign, onApproveDelivery, onRejectDelivery }) {
  const [assignmentOpen, setAssignmentOpen] = useState(false);
  const [assignmentCouriers, setAssignmentCouriers] = useState(couriers);
  const [loadingAssignmentCouriers, setLoadingAssignmentCouriers] = useState(false);
  const [assignmentLoadError, setAssignmentLoadError] = useState('');
  const [selectedCourierId, setSelectedCourierId] = useState('');
  const [assigning, setAssigning] = useState(false);
  const [approvalAction, setApprovalAction] = useState('');
  const [statusLabel, statusClass] = DELIVERY_STATUS[delivery.status] || ['Sin estado', 'status-cancelled'];
  const isTerminal = delivery.status === 'delivered' || delivery.status === 'notDelivered';
  const canAssign = Boolean(onAssign && ['offered', 'accepted'].includes(delivery.status));
  const assignmentControlsId = `delivery-assignment-${delivery.id}`;
  const toggleAssignment = async () => {
    if (assignmentOpen) {
      setAssignmentOpen(false);
      return;
    }
    setAssignmentLoadError('');
    if (!onLoadCouriers) {
      setAssignmentCouriers(couriers);
      setAssignmentOpen(true);
      return;
    }
    setLoadingAssignmentCouriers(true);
    try {
      setAssignmentCouriers(await onLoadCouriers(delivery.id));
      setAssignmentOpen(true);
    } catch (error) {
      setAssignmentCouriers([]);
      setAssignmentLoadError(error?.message || 'No se pudo consultar la cobertura del recorrido.');
      setAssignmentOpen(true);
    } finally {
      setLoadingAssignmentCouriers(false);
    }
  };
  const submitAssignment = async () => {
    if (!selectedCourierId || !onAssign) return;
    setAssigning(true);
    const assigned = await onAssign(delivery.id, selectedCourierId);
    if (assigned) {
      setAssignmentOpen(false);
      setSelectedCourierId('');
    }
    setAssigning(false);
  };
  const respondToApproval = async (approved) => {
    const handler = approved ? onApproveDelivery : onRejectDelivery;
    if (!handler || approvalAction) return;
    setApprovalAction(approved ? 'approve' : 'reject');
    await handler(delivery.id);
    setApprovalAction('');
  };
  return (
    <div className="delivery-row">
      <div className="delivery-row-main">
        <strong>{formatDeliveryPublicCode(delivery.public_code) || delivery.id?.slice(0, 8)}</strong>
        <span>{delivery.client_name || 'Operación interna'} · {delivery.neighborhood || 'Sin destino'}</span>
      </div>
      <div className="delivery-row-side">
        <div className="delivery-row-status">
          <span className={`status-badge ${statusClass}`}>{statusLabel}</span>
          {delivery.accepted_courier_id && (
            <span className={delivery.assigned_as_support ? 'assignment-badge support' : 'assignment-badge'}>
              {delivery.assigned_as_support ? 'Apoyo' : 'Base'}
            </span>
          )}
        </div>
        <small>{formatDate(delivery.created_at)}</small>
        {delivery.approval_pending && <div className="approval-request"><strong>{delivery.approval_courier_name || 'Un domiciliario'} solicita un segundo domicilio.</strong><div><button type="button" className="secondary-button compact-button" disabled={Boolean(approvalAction)} onClick={() => respondToApproval(false)}>{approvalAction === 'reject' ? 'Rechazando…' : 'Rechazar'}</button><button type="button" className="primary-button compact-button" disabled={Boolean(approvalAction)} onClick={() => respondToApproval(true)}>{approvalAction === 'approve' ? 'Aprobando…' : 'Aprobar'}</button></div></div>}
        <div className="delivery-row-actions">
          {onOpenChat && <button type="button" className="delivery-chat-button" onClick={() => onOpenChat(delivery.id)}>Abrir chat</button>}
          {canAssign && <button type="button" className="delivery-equivalent-button" aria-expanded={assignmentOpen} aria-controls={assignmentControlsId} disabled={loadingAssignmentCouriers} onClick={toggleAssignment}>{loadingAssignmentCouriers ? 'Buscando…' : assignmentOpen ? 'Cerrar' : 'Asignar'}</button>}
          {onOpenEquivalent && isTerminal && <button type="button" className="delivery-equivalent-button" onClick={() => onOpenEquivalent(delivery.id)}>Equivalente</button>}
        </div>
        {assignmentOpen && <div id={assignmentControlsId} className="delivery-assignment-controls">{assignmentLoadError ? <p className="empty-zone-couriers" role="alert">No se pudo cargar la cobertura: {assignmentLoadError}</p> : assignmentCouriers.length > 0 ? <><label><span>Asignar a</span><select value={selectedCourierId} onChange={(event) => setSelectedCourierId(event.target.value)}><option value="">Selecciona un domiciliario</option>{assignmentCouriers.map((courier) => <option key={courier.courier_id} value={courier.courier_id}>{courier.full_name || 'Domiciliario'}{courier.is_support ? ' · Apoyo general' : ` · ${courier.zone_name || 'Zona del recorrido'}`}</option>)}</select></label><button type="button" className="primary-button compact-button" disabled={!selectedCourierId || assigning} onClick={submitAssignment}>{assigning ? 'Guardando…' : 'Confirmar'}</button></> : <p className="empty-zone-couriers">No hay domiciliarios con turno vigente en las zonas de este recorrido.</p>}</div>}
      </div>
    </div>
  );
}

function EmptyActivity() {
  return <div className="empty-activity"><span>⌁</span><p>Aún no hay domicilios publicados.</p><small>Los nuevos aparecerán aquí en tiempo real.</small></div>;
}

function WeeklyCourierSchedule({ rows }) {
  const groups = useMemo(() => {
    const grouped = new Map();
    for (const row of rows) {
      const date = String(row.scheduled_for || '').slice(0, 10);
      if (!date) continue;
      if (!grouped.has(date)) grouped.set(date, []);
      grouped.get(date).push(row);
    }
    return [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right));
  }, [rows]);

  return <section className="info-card weekly-couriers-card">
    <div className="info-card-header">
      <span className="section-kicker">Turnos publicados</span>
      <span className="live-pill">Hoy</span>
    </div>
    <h3>Quién cubre esta zona hoy</h3>
    {groups.length === 0 ? <p className="empty-zone-couriers">No hay turnos publicados para hoy.</p> : <div className="weekly-courier-groups">
      {groups.map(([date, couriers]) => <div className="weekly-courier-day" key={date}>
        <div className="weekly-courier-day-heading">
          <strong>{new Intl.DateTimeFormat('es-CO', { weekday: 'long', day: '2-digit', month: 'short' }).format(new Date(`${date}T12:00:00`))}</strong>
          <span>{couriers.length} {couriers.length === 1 ? 'domiciliario' : 'domiciliarios'}</span>
        </div>
        <div className="weekly-courier-names">
          {couriers.map((courier) => <span className={courier.is_support ? 'weekly-courier-name support' : 'weekly-courier-name'} key={`${date}-${courier.courier_id}-${courier.starts_at}`}>
            {courier.full_name || 'Domiciliario'}{courier.is_support ? ' · apoyo' : ''} · {formatTime(courier.starts_at)}–{formatTime(courier.ends_at)}
          </span>)}
        </div>
      </div>)}
    </div>}
  </section>;
}

function PharmacyScheduleView({ pharmacy, rows, breakdown, breakdownError, courierDeliveryDetails, breakdownLoading, onOpenEquivalent, onViewDetails }) {
  return <div className="pharmacy-page-grid">
    <section className="form-card schedule-page-card">
      <div className="card-heading">
        <div>
          <span className="section-kicker">Cobertura publicada</span>
          <h2>{formatPharmacyDisplay(pharmacy)} · turnos</h2>
        </div>
        <div className="zone-chip"><span /> {pharmacy.zone_name || 'Zona pendiente'}</div>
      </div>
      <p className="page-intro">Consulta quién está disponible hoy. Al cambiar el día se muestran solo los turnos nuevos. Los apoyos generales aparecen aquí porque pueden atender cualquier farmacia.</p>
      <WeeklyCourierSchedule rows={rows} />
    </section>
    <aside className="side-column">
      <CourierBreakdownCard
        breakdown={breakdown}
        deliveries={courierDeliveryDetails}
        error={breakdownError}
        loading={breakdownLoading}
        compact
        onOpenEquivalent={onOpenEquivalent}
        onViewDetails={onViewDetails}
      />
      <div className="info-card accent-card">
        <span className="card-icon">⌁</span>
        <div><span className="section-kicker">Regla operativa</span><h3>Apoyo general</h3><p>Si la farmacia necesita mover un domicilio, puede asignarlo a un apoyo elegible de la zona.</p></div>
      </div>
    </aside>
  </div>;
}

function PharmacySettingsView({ pharmacy, profile, profiles, webPushState, onEnableWebPush, onDisableWebPush, onSignOut }) {
  const pushStatus = webPushState.enabled
    ? 'Activo'
    : webPushState.permission === 'denied'
      ? 'Bloqueado'
      : webPushState.supported
        ? 'Sin activar'
        : 'Pendiente';
  const pushDescription = webPushState.enabled
    ? 'Recibirás avisos aunque cierres esta pestaña o dejes la web en segundo plano.'
    : webPushState.error || webPushState.message || (!webPushState.configured
      ? 'El administrador debe configurar la clave Web Push antes de activar esta función.'
      : 'Activa las alertas en este dispositivo para recibir domicilios y mensajes nuevos.');
  return <div className="pharmacy-page-grid settings-page-grid">
    <section className="form-card settings-page-card">
      <div className="card-heading">
        <div><span className="section-kicker">Cuenta operativa</span><h2>Ajustes de farmacia</h2></div>
        <span className="live-pill">Supabase conectado</span>
      </div>
      <div className="settings-summary-grid">
        <div className="settings-summary-item"><span>Farmacia</span><strong>{formatPharmacyDisplay(pharmacy)}</strong><small>{pharmacy.zone_name || 'Zona pendiente'}</small></div>
        <div className="settings-summary-item"><span>Perfil activo</span><strong>{profile?.full_name || 'Vendedor'}</strong><small>{profiles.length} perfil{profiles.length === 1 ? '' : 'es'} disponibles</small></div>
      </div>
      <div className="settings-info-list">
        <div><span>Datos</span><p>Los domicilios, clientes, chats y equivalentes se guardan en la base compartida de farmanorte.</p></div>
        <div><span>Equivalentes</span><p>La farmacia puede ver el soporte cuando el domiciliario lo firma manualmente.</p></div>
        <div className="push-settings-card">
          <div className="push-settings-heading">
            <div><span>Alertas en segundo plano</span><h3>Notificaciones web</h3><p>{pushDescription}</p></div>
            <strong className={webPushState.enabled ? 'push-status active' : webPushState.permission === 'denied' ? 'push-status blocked' : 'push-status'}>{pushStatus}</strong>
          </div>
          {webPushState.supported && <button type="button" className="secondary-button push-settings-action" onClick={webPushState.enabled ? onDisableWebPush : onEnableWebPush} disabled={webPushState.loading}>{webPushState.loading ? 'Guardando…' : webPushState.enabled ? 'Desactivar en este dispositivo' : 'Activar alertas en segundo plano'}</button>}
          <small className="push-settings-help">En iPhone, añade la página a la pantalla de inicio y permite las notificaciones. En escritorio, acepta el permiso del sitio.</small>
        </div>
      </div>
      <button type="button" className="secondary-button settings-signout" onClick={onSignOut}>Cerrar sesión <span>↗</span></button>
    </section>
  </div>;
}

function CourierBreakdownCard({ breakdown, deliveries = [], error, loading = false, compact = false, onOpenEquivalent, onViewDetails }) {
  const deliveriesByCourier = new Map();
  for (const delivery of deliveries) {
    const courierId = delivery.courier_id;
    if (!courierId) continue;
    const current = deliveriesByCourier.get(courierId) ?? [];
    current.push(delivery);
    deliveriesByCourier.set(courierId, current);
  }

  const totalDeliveryRows = deliveries.length;
  const visibleDeliveryRows = compact
    ? [...deliveriesByCourier.values()].reduce((count, rows) => count + Math.min(rows.length, 2), 0)
    : totalDeliveryRows;

  return <section className={compact ? 'courier-breakdown-card compact' : 'courier-breakdown-card'}>
    <div className="courier-breakdown-heading">
      <div><span className="section-kicker">Rendimiento real</span><h3>Ganancias por domiciliario</h3><p>Cuenta entregas; la ganancia se libera al firmar el equivalente.</p></div>
      <span className="courier-breakdown-icon" aria-hidden="true">↗</span>
    </div>
    {loading ? <p className="courier-breakdown-empty" role="status">Cargando servicios y equivalentes…</p>
      : error ? <p className="courier-breakdown-empty" role="alert">No se pudo cargar el desglose: {error}</p>
        : breakdown.length === 0 ? <p className="courier-breakdown-empty">Aún no hay domicilios entregados para mostrar.</p>
          : <div className="courier-breakdown-list">{breakdown.map((item) => {
            const courierDeliveries = deliveriesByCourier.get(item.courier_id) ?? [];
            const visibleDeliveries = compact ? courierDeliveries.slice(0, 2) : courierDeliveries;
            return <div className="courier-breakdown-group" key={item.courier_id}>
              <div className="courier-breakdown-row">
                <div className="courier-breakdown-avatar" aria-hidden="true">{(item.courier_name || 'D').slice(0, 1).toUpperCase()}</div>
                <div className="courier-breakdown-main"><strong>{item.courier_name || 'Domiciliario'}</strong><span>{item.service_count} entregado{item.service_count === 1 ? '' : 's'} · {item.base_count} base · {item.support_count} apoyo</span></div>
                <div className="courier-breakdown-earnings"><span>Ganancia liberada</span><strong className="courier-breakdown-amount">{formatMoney(item.total_earnings)}</strong></div>
              </div>
              {visibleDeliveries.length > 0 && <div className="courier-delivery-details">
                {visibleDeliveries.map((delivery) => {
                  const signed = ['signed', 'acknowledged'].includes(delivery.equivalent_status);
                  const deliveryCode = formatDeliveryPublicCode(delivery.public_code) || delivery.delivery_id?.slice(0, 8) || 'Domicilio';
                  return <div className="courier-delivery-detail" key={delivery.delivery_id}>
                    <div className="courier-delivery-copy">
                      <strong>{deliveryCode}</strong>
                      <span>{delivery.service_type || 'Servicio'} · {formatDate(delivery.delivered_at)}</span>
                    </div>
                    <div className="courier-delivery-state">
                      <span className={signed ? 'equivalent-signature-status signed' : 'equivalent-signature-status'}>{signed ? 'Equivalente firmado' : 'Pendiente de firma'}</span>
                      <strong>{signed ? formatMoney(delivery.released_earnings) : 'Ganancia pendiente'}</strong>
                    </div>
                    {signed && delivery.equivalent_id && onOpenEquivalent && <button type="button" className="courier-equivalent-link" onClick={() => onOpenEquivalent(delivery.delivery_id)}>Ver equivalente</button>}
                  </div>;
                })}
              </div>}
            </div>;
          })}</div>}
    {!loading && !error && compact && totalDeliveryRows > visibleDeliveryRows && <button type="button" className="courier-report-more" onClick={onViewDetails}>Ver todos los domicilios ({totalDeliveryRows})</button>}
  </section>;
}

function HistoryView({ deliveries, pharmacy, session, profile, selectedChatDeliveryId, onOpenChat, selectedEquivalentDeliveryId, onOpenEquivalent, couriers, onLoadCouriers, onAssign, onApproveDelivery, onRejectDelivery, courierBreakdown, courierBreakdownError, courierDeliveryDetails, courierBreakdownLoading, viewMode = 'history' }) {
  const isReception = viewMode === 'reception';
  const [filter, setFilter] = useState(isReception ? 'delivered' : 'all');
  const filtered = useMemo(() => {
    if (isReception) return deliveries.filter((delivery) => ['delivered', 'notDelivered'].includes(delivery.status));
    return filter === 'all' ? deliveries : deliveries.filter((delivery) => delivery.status === filter);
  }, [deliveries, filter, isReception]);
  const selectedDelivery = deliveries.find((delivery) => delivery.id === selectedChatDeliveryId) ?? null;
  const selectedEquivalentDelivery = deliveries.find((delivery) => delivery.id === selectedEquivalentDeliveryId)
    ?? (() => {
      const reportDelivery = courierDeliveryDetails.find((delivery) => delivery.delivery_id === selectedEquivalentDeliveryId);
      return reportDelivery ? { ...reportDelivery, id: reportDelivery.delivery_id } : null;
    })();
  const hasTools = Boolean(selectedDelivery || selectedEquivalentDelivery);
  return (
    <section className="history-page">
      <div className="history-toolbar">
        <div>
          <span className="section-kicker">{isReception ? 'Soportes de' : 'Pedidos de'} {formatPharmacyDisplay(pharmacy)}</span>
          <h2>{isReception ? 'Recepción de equivalentes' : 'Todos los pedidos'}</h2>
          <p>{isReception ? 'Revisa los servicios finalizados y abre el equivalente firmado para confirmar su recepción.' : 'Pedidos recibidos directamente desde Supabase. No hay registros locales.'}</p>
        </div>
        {!isReception && <div className="filter-row">
          {[
            ['all', 'Todos'],
            ['offered', 'Publicados'],
            ['accepted', 'Aceptados'],
            ['delivered', 'Entregados'],
          ].map(([value, label]) => (
            <button
              key={value}
              className={filter === value ? 'filter-button active' : 'filter-button'}
              type="button"
              onClick={() => setFilter(value)}
            >
              {label}
            </button>
          ))}
        </div>}
      </div>
      <CourierBreakdownCard
        breakdown={courierBreakdown}
        deliveries={courierDeliveryDetails}
        error={courierBreakdownError}
        loading={courierBreakdownLoading}
        onOpenEquivalent={onOpenEquivalent}
      />
      <div className={hasTools ? 'history-workspace has-tools' : 'history-workspace'}>
        <div className="history-list">
          {filtered.map((delivery) => (
            <DeliveryRow
              key={delivery.id}
              delivery={delivery}
              couriers={couriers}
              onLoadCouriers={onLoadCouriers}
              onAssign={onAssign}
              onApproveDelivery={onApproveDelivery}
              onRejectDelivery={onRejectDelivery}
              onOpenChat={onOpenChat}
              onOpenEquivalent={onOpenEquivalent}
            />
          ))}
          {filtered.length === 0 && (
            <div className="empty-history">
              <span>○</span>
              <h3>No hay pedidos para mostrar</h3>
              <p>Cuando publiques un domicilio aparecerá aquí.</p>
            </div>
          )}
        </div>
        {hasTools && (
          <div className="history-tool-stack">
            {selectedDelivery && (
              <DeliveryChatPanel
                delivery={selectedDelivery}
                session={session}
                profile={profile}
                onClose={() => onOpenChat(null)}
              />
            )}
            {selectedEquivalentDelivery && (
              <DeliveryEquivalentPanel
                delivery={selectedEquivalentDelivery}
                session={session}
                profile={profile}
                onClose={() => onOpenEquivalent(null)}
              />
            )}
          </div>
        )}
      </div>
    </section>
  );
}

function equivalentInvoiceNumber(equivalent, delivery) {
  const code = equivalent?.metadata?.public_code || delivery.public_code || equivalent?.delivery_id || equivalent?.id || '';
  return formatDeliveryPublicCode(code);
}

function equivalentConcept(equivalent) {
  const service = String(equivalent?.service_label || '').toLowerCase();
  const description = String(equivalent?.description || '').trim();
  const stops = Array.isArray(equivalent?.metadata?.pickup_stops)
    ? equivalent.metadata.pickup_stops
    : [];
  const routes = stops
    .map((stop) => {
      const origin = stop?.origin_pharmacy_code ?? stop?.originPharmacyCode ?? stop?.pharmacy_code;
      const destination = stop?.destination_pharmacy_code ?? stop?.destinationPharmacyCode;
      return origin && destination
        ? `${formatPharmacyCodeLabel(origin)} a ${formatPharmacyCodeLabel(destination)}`
        : null;
    })
    .filter(Boolean);
  if (service.includes('compra') && service.includes('cruce')) {
    const routeText = routes.length > 0 ? ` ${routes.join(' · ')}.` : '';
    return `Se hace domicilio con compra y cruce.${routeText} ${description}`.trim();
  }
  if (service.includes('cruce')) {
    if (routes.length > 0) {
      return `${routes.length === 1 ? 'Se realiza cruce de' : 'Se realizan cruces:'} ${routes.join(' · ')}.`;
    }
    return `Se hace domicilio con cruce. ${description}`.trim();
  }
  if (service.includes('compra')) return `Se hace compra externa. ${description}`.trim();
  if (service.includes('domicilio')) {
    const payment = equivalent?.payment_method === 'cash' ? 'efectivo' : ['card', 'qr'].includes(equivalent?.payment_method) ? 'datáfono' : 'el método de pago registrado';
    return `Se hace domicilio con ${payment}.`;
  }
  return description || 'Servicio de mensajería registrado.';
}

function EquivalentReceipt({ equivalent, delivery, statusText, receiptRef }) {
  const metadata = equivalent?.metadata || {};
  const invoiceNumber = equivalentInvoiceNumber(equivalent, delivery);
  const signature = equivalent.courier_signature_name || 'Pendiente de firma';
  return <div ref={receiptRef} className="equivalent-receipt" data-equivalent-receipt>
    <div className="equivalent-receipt-brand">
      <img src={`${import.meta.env.BASE_URL}jr-mensajeria-express.png`} alt="JR Mensajería Express" />
      <div className="equivalent-brand-meta"><strong>JR Mensajería Express</strong><span>324 660 2056</span></div>
      <div className="equivalent-invoice-number"><span>No.</span><strong>{invoiceNumber}</strong></div>
    </div>
    <div className="equivalent-receipt-grid">
      <div><span>Fecha</span><strong>{formatDate(equivalent.created_at)}</strong></div>
      <div><span>Valor $</span><strong>{formatMoney(equivalent.amount)}</strong></div>
    </div>
    <div className="equivalent-field invoice-row"><span>Recibo de</span><strong>{formatPharmacyDisplay({ code: equivalent.pharmacy_code })}</strong></div>
    <div className="equivalent-concept"><span>Por concepto de</span><strong>{equivalentConcept(equivalent)}</strong></div>
    <div className="equivalent-receipt-footer">
      <div><span>Firma</span>{equivalent.courier_signature_image ? <img className="equivalent-signature-image" src={equivalent.courier_signature_image} alt={`Firma de ${signature}`} /> : <strong>{signature}</strong>}</div>
      <div className="equivalent-total"><span>Total $</span><strong>{formatMoney(equivalent.amount)}</strong></div>
    </div>
    <div className="equivalent-status"><span className="status-badge status-delivered">{statusText}</span>{equivalent.courier_signed_at && <small>Firmado {formatDate(equivalent.courier_signed_at)}</small>}</div>
  </div>;
}

function DeliveryEquivalentPanel({ delivery, session, profile, onClose }) {
  const [equivalent, setEquivalent] = useState(null);
  const [loading, setLoading] = useState(true);
  const [equivalentError, setEquivalentError] = useState('');
  const [acknowledging, setAcknowledging] = useState(false);
  const [markingPaid, setMarkingPaid] = useState(false);
  const [downloadingPdf, setDownloadingPdf] = useState(false);
  const [downloadingImage, setDownloadingImage] = useState(false);
  const receiptRef = useRef(null);

  const loadEquivalent = async () => {
    if (!supabase || !delivery.id) {
      setLoading(false);
      setEquivalentError('La conexión real de Supabase no está disponible.');
      return;
    }
    setLoading(true);
    const { data, error: loadError } = await supabase
      .from('delivery_equivalents')
      .select('*')
      .eq('delivery_id', delivery.id)
      .maybeSingle();
    if (loadError) setEquivalentError(getErrorMessage(loadError));
    else {
      // La política RLS ya oculta los borradores a la farmacia. Este filtro
      // también protege la interfaz si una notificación en tiempo real llega
      // antes de que Supabase vuelva a evaluar la lectura.
      const pharmacyCanSee = data && ['signed', 'acknowledged'].includes(data.status);
      setEquivalent(pharmacyCanSee ? data : null);
      setEquivalentError(pharmacyCanSee ? '' : 'Pendiente de firma del domiciliario. La farmacia podrá ver y confirmar el equivalente cuando esté firmado.');
    }
    setLoading(false);
  };

  useEffect(() => {
    let mounted = true;
    let channel;
    const run = async () => {
      await loadEquivalent();
      if (!mounted || !supabase) return;
      channel = supabase
        .channel(`delivery-equivalent-${delivery.id}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'delivery_equivalents', filter: `delivery_id=eq.${delivery.id}` }, () => { void loadEquivalent(); })
        .subscribe();
    };
    void run();
    return () => {
      mounted = false;
      if (channel) supabase?.removeChannel(channel);
    };
  }, [delivery.id]);

  const acknowledge = async () => {
    if (!equivalent || !supabase || acknowledging) return;
    setAcknowledging(true);
    setEquivalentError('');
    const { error: acknowledgeError } = await supabase.rpc('acknowledge_delivery_equivalent', { requested_equivalent_id: equivalent.id });
    if (acknowledgeError) setEquivalentError(getErrorMessage(acknowledgeError));
    else await loadEquivalent();
    setAcknowledging(false);
  };

  const markPaid = async () => {
    if (!equivalent || !supabase || markingPaid || equivalent.payment_status === 'paid') return;
    setMarkingPaid(true);
    setEquivalentError('');
    const { error: paymentError } = await supabase.rpc('mark_delivery_equivalent_paid', {
      requested_equivalent_id: equivalent.id,
      requested_paid_amount: equivalent.amount,
    });
    if (paymentError) setEquivalentError(getErrorMessage(paymentError));
    else await loadEquivalent();
    setMarkingPaid(false);
  };

  const downloadPdf = async () => {
    if (!equivalent || !receiptRef.current || downloadingPdf) return;
    setDownloadingPdf(true);
    setEquivalentError('');
    try {
      const dataUrl = await toPng(receiptRef.current, { cacheBust: true, pixelRatio: 3, backgroundColor: '#ffffff' });
      const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a5' });
      const pageWidth = pdf.internal.pageSize.getWidth();
      const image = pdf.getImageProperties(dataUrl);
      const imageWidth = Math.min(135, pageWidth - 20);
      const imageHeight = (image.height * imageWidth) / image.width;
      pdf.addImage(dataUrl, 'PNG', (pageWidth - imageWidth) / 2, 10, imageWidth, imageHeight, undefined, 'FAST');
      pdf.save(`equivalente-${equivalentInvoiceNumber(equivalent, delivery).toLowerCase()}.pdf`);
    } catch (error) {
      setEquivalentError(`No se pudo descargar el PDF: ${getErrorMessage(error)}`);
    } finally {
      setDownloadingPdf(false);
    }
  };

  const downloadImage = async () => {
    if (!equivalent || !receiptRef.current || downloadingImage) return;
    setDownloadingImage(true);
    setEquivalentError('');
    try {
      const dataUrl = await toPng(receiptRef.current, { cacheBust: true, pixelRatio: 2, backgroundColor: '#ffffff' });
      const link = document.createElement('a');
      link.download = `equivalente-${equivalentInvoiceNumber(equivalent, delivery).toLowerCase()}.png`;
      link.href = dataUrl;
      link.click();
    } catch (error) {
      setEquivalentError(`No se pudo descargar la imagen: ${getErrorMessage(error)}`);
    } finally {
      setDownloadingImage(false);
    }
  };

  const statusText = equivalent?.status === 'acknowledged' ? 'Recibido por farmacia' : equivalent?.status === 'signed' ? 'Firmado por el domiciliario' : 'Pendiente de firma';

  const paymentRegistered = equivalent?.payment_status === 'paid';
  return <aside className="delivery-equivalent-panel" aria-label="Equivalente digital"><div className="equivalent-panel-header"><div><span className="section-kicker">Soporte registrado</span><h3>Equivalente {formatDeliveryPublicCode(delivery.public_code) || delivery.id?.slice(0, 8)}</h3><p>{delivery.client_name || 'Operación interna'} · {statusText}</p></div><button type="button" className="chat-close-button" onClick={onClose} aria-label="Cerrar equivalente">×</button></div><div className="equivalent-panel-body">{loading ? <p className="equivalent-empty">Cargando equivalente real…</p> : equivalentError ? <p className="equivalent-error" role="alert">{equivalentError}</p> : equivalent ? <><EquivalentReceipt equivalent={equivalent} delivery={delivery} statusText={statusText} receiptRef={receiptRef} />{equivalent.status !== 'acknowledged' && <button type="button" className="primary-button full-width" onClick={acknowledge} disabled={acknowledging}>{acknowledging ? 'Guardando recepción…' : 'Confirmar recepción en farmacia'}</button>}<div className={paymentRegistered ? 'equivalent-payment-state paid' : 'equivalent-payment-state'} role="status">{paymentRegistered ? <><strong>Pago registrado</strong><span>{formatMoney(equivalent.paid_amount ?? equivalent.amount)} · {equivalent.paid_at ? formatDate(equivalent.paid_at) : 'fecha pendiente'}</span></> : <><strong>Pago pendiente</strong><span>Registra el pago cuando la farmacia haya liquidado este soporte.</span><button type="button" className="secondary-button full-width" onClick={markPaid} disabled={markingPaid}>{markingPaid ? 'Registrando pago…' : 'Registrar pago'}</button></>}</div><div className="equivalent-download-actions"><button type="button" className="secondary-button" onClick={downloadPdf} disabled={downloadingPdf}>{downloadingPdf ? 'Preparando PDF…' : 'Descargar PDF'}</button><button type="button" className="secondary-button" onClick={downloadImage} disabled={downloadingImage}>{downloadingImage ? 'Preparando imagen…' : 'Descargar imagen'}</button></div><p className="equivalent-help">El mismo soporte queda disponible para la farmacia y el domiciliario.</p></> : null}</div></aside>;
}

function DeliveryChatPanel({ delivery, session, profile, onClose }) {
  const [messages, setMessages] = useState([]);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [chatError, setChatError] = useState('');
  const composerRef = useRef(null);

  useEffect(() => {
    composerRef.current?.focus();
  }, [delivery.id]);

  useEffect(() => {
    let mounted = true;
    let channel;

    const loadMessages = async () => {
      if (!supabase || !delivery.id) {
        setLoading(false);
        return;
      }
      const { data, error: loadError } = await supabase
        .from('delivery_chat_messages')
        .select('*')
        .eq('delivery_id', delivery.id)
        .order('created_at', { ascending: true });
      if (!mounted) return;
      if (loadError) {
        setChatError(getErrorMessage(loadError));
      } else {
        setMessages(data ?? []);
      }
      setLoading(false);

      channel = supabase
        .channel(`delivery-chat-${delivery.id}`)
        .on(
          'postgres_changes',
          {
            event: 'INSERT',
            schema: 'public',
            table: 'delivery_chat_messages',
            filter: `delivery_id=eq.${delivery.id}`,
          },
          (payload) => {
            setMessages((current) => current.some((message) => message.id === payload.new.id)
              ? current
              : [...current, payload.new]);
          },
        )
        .subscribe();
    };

    void loadMessages();
    return () => {
      mounted = false;
      if (channel) supabase?.removeChannel(channel);
    };
  }, [delivery.id]);

  const sendMessage = async (event) => {
    event.preventDefault();
    const body = draft.trim();
    if (!body || !supabase || !session?.user?.id || sending) return;
    setSending(true);
    setChatError('');
    const { data, error: sendError } = await supabase
      .from('delivery_chat_messages')
      .insert({ delivery_id: delivery.id, sender_id: session.user.id, body })
      .select('*')
      .single();
    if (sendError) {
      setChatError(getErrorMessage(sendError));
    } else if (data) {
      setMessages((current) => current.some((message) => message.id === data.id) ? current : [...current, data]);
      setDraft('');
      triggerPushNotification({ event: 'chat_message', delivery_id: delivery.id, message_id: data.id });
    }
    setSending(false);
  };

  return <aside className="delivery-chat-panel" aria-label="Chat del domicilio"><div className="chat-panel-header"><div><span className="section-kicker">Conversación registrada</span><h3>Chat {formatDeliveryPublicCode(delivery.public_code) || delivery.id?.slice(0, 8)}</h3><p>{delivery.client_name || 'Operación interna'} · {delivery.status ? (DELIVERY_STATUS[delivery.status]?.[0] || delivery.status) : 'Sin estado'}</p></div><button type="button" className="chat-close-button" onClick={onClose} aria-label="Cerrar chat">×</button></div><div className="chat-participant"><span className="chat-participant-dot" /><span>Farmacia y domiciliario · el administrador también puede consultar esta conversación</span></div><div className="chat-messages" aria-live="polite">{loading ? <p className="chat-empty">Cargando mensajes reales…</p> : messages.length === 0 ? <p className="chat-empty">Todavía no hay mensajes. Escribe para coordinar este domicilio.</p> : messages.map((message) => <div key={message.id} className={message.sender_id === session?.user?.id ? 'chat-message own' : 'chat-message'}><div className="chat-message-meta"><strong>{message.sender_name || (message.sender_role === 'pharmacy' ? 'Farmacia' : 'Domiciliario')}</strong><time>{formatDate(message.created_at)}</time></div><p>{message.body}</p></div>)}</div>{chatError && <p className="chat-error" role="alert">{chatError}</p>}<form className="chat-composer" onSubmit={sendMessage}><label className="sr-only" htmlFor="pharmacy-chat-message">Mensaje</label><input ref={composerRef} id="pharmacy-chat-message" value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={`Escribe como ${profile?.full_name || 'farmacia'}`} maxLength="2000" disabled={sending} /><button type="submit" className="primary-button" disabled={sending || !draft.trim()}>{sending ? '…' : 'Enviar'}</button></form></aside>;
}

function ConfigScreen() {
  return <div className="center-screen"><div className="config-card"><BrandLogo /><span className="section-kicker">Configuración requerida</span><h1>Conecta el panel con Supabase</h1><p>Faltan <code>VITE_SUPABASE_URL</code> y <code>VITE_SUPABASE_PUBLISHABLE_KEY</code>. Cópialas en <code>pharmacy_web/.env.local</code> antes de ejecutar la página.</p><div className="config-code">VITE_SUPABASE_URL=https://tu-proyecto.supabase.co<br />VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_...</div></div></div>;
}

function LoadingScreen() {
  return <div className="center-screen"><div className="loading-card"><div className="spinner" /><p>Validando usuario y cargando la farmacia…</p></div></div>;
}

function AccessProblem({ error, onSignOut }) {
  return <div className="center-screen"><div className="problem-card"><div className="problem-icon">!</div><span className="section-kicker">Acceso detenido</span><h1>No se cargó el panel</h1><p>{error}</p><button className="secondary-button" onClick={onSignOut}>Cerrar sesión</button></div></div>;
}

export default App;

createRoot(document.getElementById('root')).render(<App />);

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    registerWebAppServiceWorker().catch(() => {
      // La página sigue funcionando aunque el navegador no permita PWA.
    });
  });
}
