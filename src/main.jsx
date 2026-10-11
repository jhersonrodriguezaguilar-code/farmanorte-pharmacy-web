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
  const code = String(pharmacy?.code ?? '').trim();
  return code ? `farmanorte ${code}` : 'farmanorte';
}

function formatPharmacyCodeLabel(code) {
  const normalized = String(code ?? '').trim().replace(/^FN\s+/i, '');
  return normalized ? `FN ${normalized.toUpperCase()}` : 'FN';
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

function makePublicCode(pharmacyCode, sequence) {
  return `FN ${pharmacyCode} ${String(sequence).padStart(2, '0')}`;
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

function BrandLogo({ inverse = false }) {
  if (inverse) {
    return (
      <div className="brand-logo-inverse" role="img" aria-label="FarmaNorte">
        <svg viewBox="0 0 44 44" aria-hidden="true">
          <circle cx="22" cy="22" r="18.5" fill="none" stroke="currentColor" strokeWidth="2.8" />
          <path d="M15 30V14.5h15M15 21.5h11" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span>Farmanorte</span>
      </div>
    );
  }

  return <img className="brand-logo" src={`${import.meta.env.BASE_URL}farmanorte-logo.png`} alt="FarmaNorte" />;
}

const HERO_TITLE = 'Cada entrega, siempre registrada.';
const HERO_COPY = 'Publica, sigue y deja registrado cada domicilio desde el punto de farmacia.';

function LoginHeroCopy() {
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
        <h1>{visibleTitle}<span className="hero-caret">|</span></h1>
        <p>{visibleCopy}</p>
      </div>
      <span className="sr-only">{HERO_TITLE} {HERO_COPY}</span>
    </>
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
            <button className="primary-button full-width" disabled={submitting}>{submitting ? 'Actualizando…' : 'Guardar contraseña'} <ArrowIcon /></button>
          </form>
          <div className="auth-note"><ShieldIcon /><span>Acceso seguro para personal autorizado</span></div>
        </div>
      </main>
    </div>
  );
}

function LoginScreen() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const requestPasswordReset = async () => {
    setError('');
    setNotice('');
    if (!email.trim()) {
      setError('Escribe tu usuario o correo para solicitar la recuperación.');
      document.getElementById('login-email')?.focus();
      return;
    }
    setResetting(true);
    const { error: resetError } = await supabase.auth.resetPasswordForEmail(normalizeAuthIdentifier(email), {
      redirectTo: `${window.location.origin}/?mode=reset-password`,
    });
    if (resetError) {
      setError('No se pudo solicitar el restablecimiento. Verifica el usuario o correo e inténtalo nuevamente.');
    } else {
      setNotice('Si el usuario tiene un correo asociado, recibirás instrucciones para restablecer la contraseña.');
    }
    setResetting(false);
  };

  const submit = async (event) => {
    event.preventDefault();
    setSubmitting(true);
    setError('');
    setNotice('');
    const { error: signInError } = await supabase.auth.signInWithPassword({ email: normalizeAuthIdentifier(email), password });
    if (signInError) setError('No se pudo iniciar sesión. Verifica tus credenciales e inténtalo nuevamente.');
    setSubmitting(false);
  };

  return <div className="auth-page"><div className="auth-aside"><div className="brand-lockup"><BrandLogo inverse /></div><div className="auth-quote"><LoginHeroCopy /></div><div className="auth-aside-footer">Panel privado para personal autorizado</div></div><main className="auth-main"><LoginAmbient /><div className="auth-form-wrap"><span className="section-kicker">ACCESO DE FARMACIA</span><h2>Inicia sesión</h2><p className="auth-copy">Ingresa con las credenciales que te asignó el administrador.</p>{error && <div id="login-error" className="inline-alert error-alert" role="alert" aria-live="assertive">{error}</div>}{notice && <div className="inline-alert success-alert" role="status" aria-live="polite">{notice}</div>}<form onSubmit={submit} className="auth-form" aria-busy={submitting}><Field label="Usuario o correo" required id="login-email"><div className="auth-input-shell"><span className="auth-input-icon"><UserIcon /></span><input id="login-email" type="text" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="Ingresa tu usuario o correo" autoComplete="username" required aria-describedby={error ? 'login-error' : undefined} /></div></Field><Field label="Contraseña" required id="login-password"><div className="auth-input-shell"><span className="auth-input-icon"><LockIcon /></span><input id="login-password" type={showPassword ? 'text' : 'password'} value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Ingresa tu contraseña" autoComplete="current-password" required aria-describedby={error ? 'login-error' : undefined} /><button type="button" className="password-toggle" aria-label={showPassword ? 'Ocultar contraseña' : 'Mostrar contraseña'} aria-pressed={showPassword} onMouseDown={(event) => event.preventDefault()} onClick={() => setShowPassword((visible) => !visible)}><EyeIcon hidden={showPassword} /></button></div></Field><div className="auth-recovery-row"><button type="button" className="forgot-link" onClick={requestPasswordReset} disabled={resetting}>{resetting ? 'Enviando instrucciones…' : '¿Olvidaste tu contraseña?'}</button></div><button className="primary-button full-width" disabled={submitting}>{submitting ? 'Verificando acceso…' : 'Entrar al panel'} <ArrowIcon /></button></form><div className="auth-note"><ShieldIcon /><span>Acceso seguro para personal autorizado</span></div></div></main></div>;
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
  const [deliveries, setDeliveries] = useState([]);
  const [loading, setLoading] = useState(Boolean(supabase));
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [activeView, setActiveView] = useState('publish');
  const [chatDeliveryId, setChatDeliveryId] = useState(null);
  const [equivalentDeliveryId, setEquivalentDeliveryId] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [publishing, setPublishing] = useState(false);

  useEffect(() => {
    if (!supabase) {
      setLoading(false);
      return undefined;
    }

    let mounted = true;
    let channel;
    let lastUserId = null;
    let loadRequest = 0;

    const clearWorkspace = () => {
      setProfile(null);
      setPharmacyProfiles([]);
      setSelectedPharmacyProfile(null);
      setPharmacy(null);
      setAvailablePharmacies([]);
      setZone(null);
      setZoneCouriers([]);
      setDeliveries([]);
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
        .select('id, full_name, role, pharmacy_code, phone, active')
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

      if (!profileData.active) {
        setError('Este usuario está inactivo. Contacta al administrador.');
        setLoading(false);
        return;
      }
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

      const { data: pharmacyProfileData, error: pharmacyProfilesError } = await supabase
        .from('pharmacy_profiles')
        .select('id, pharmacy_code, display_name, username, profile_role, active')
        .eq('pharmacy_code', profileData.pharmacy_code)
        .eq('active', true)
        .order('display_name');

      if (!isCurrent()) return;
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

      const { data: pharmacyData, error: pharmacyError } = await supabase
        .from('pharmacies')
        .select('code, name, zone_name, address, active')
        .eq('code', profileData.pharmacy_code)
        .maybeSingle();

      if (!isCurrent()) return;
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

      const { data: pharmacyCatalog, error: pharmacyCatalogError } = await supabase
        .from('pharmacies')
        .select('code, name, zone_name, active')
        .eq('active', true)
        .order('code');

      if (!isCurrent()) return;
      if (pharmacyCatalogError) {
        setAvailablePharmacies([]);
      } else {
        setAvailablePharmacies(pharmacyCatalog ?? []);
      }

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
          return;
        }
        const { data: courierData, error: courierError } = await supabase.rpc(
          'get_pharmacy_zone_couriers',
          {
            requested_zone_id: directZone.id,
            requested_date: localDateIso(),
          },
        );
        if (!isCurrent()) return;
        if (courierError) {
          setZoneCouriers([]);
          setError(getErrorMessage(courierError));
          return;
        }
        setZoneCouriers(courierData ?? []);
      };

      await loadZoneCouriers();
      if (!isCurrent()) return;

      const { data: deliveryData, error: deliveriesError } = await supabase
        .from('deliveries')
        .select('*')
        .eq('pharmacy_code', pharmacyData.code)
        .order('created_at', { ascending: false })
        .limit(30);

      if (!isCurrent()) return;
      if (deliveriesError) {
        setError(getErrorMessage(deliveriesError));
      } else {
        setDeliveries(deliveryData ?? []);
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
                setNotice(`Nuevo domicilio disponible: ${payload.new.public_code || payload.new.id?.slice(0, 8)}`);
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
          },
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
          () => void loadZoneCouriers(),
        )
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'courier_presence' },
          () => void loadZoneCouriers(),
        )
        .subscribe();
    };

    const applySession = (nextSession) => {
      if (!mounted) return;
      setSession(nextSession);
      if (!nextSession) {
        lastUserId = null;
        loadRequest += 1;
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
      if (event === 'SIGNED_OUT') setRecoveryMode(false);
      applySession(nextSession);
    });

    void loadSession();

    return () => {
      mounted = false;
      loadRequest += 1;
      authListener.subscription.unsubscribe();
      if (channel) supabase.removeChannel(channel);
    };
  }, []);

  const signOut = async () => {
    if (!supabase) return;
    setError('');
    setNotice('');
    try {
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
      setChatDeliveryId(null);
      setEquivalentDeliveryId(null);
      setForm(createEmptyForm());
      setActiveView('publish');
    } catch (signOutException) {
      setError(`No se pudo cerrar sesión: ${getErrorMessage(signOutException)}`);
    }
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
    const courier = assignedCouriers.find((item) => item.courier_id === courierId);
    setNotice(`Domicilio reasignado a ${courier?.full_name || 'el domiciliario seleccionado'}.`);
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

  const updateServiceType = (serviceType) => {
    const nextServiceType = getServiceTypeConfig(serviceType);
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
    const deliveryTasks = buildDeliveryTasks(form);
    const { count: pharmacyDeliveryCount, error: codeCountError } = await supabase
      .from('deliveries')
      .select('id', { count: 'exact', head: true })
      .eq('pharmacy_code', pharmacy.code);
    if (codeCountError) {
      setError(`No se pudo generar el consecutivo del domicilio: ${getErrorMessage(codeCountError)}`);
      setPublishing(false);
      return;
    }
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
      public_code: makePublicCode(pharmacy.code, (pharmacyDeliveryCount ?? 0) + 1),
      pharmacy_code: pharmacy.code,
      zone_id: zone.id,
      kind: form.kind,
      service_type: form.serviceType,
      status: 'offered',
      client_name: requiresClient ? form.clientName.trim() : '',
      client_phone: requiresClient ? form.clientPhone.trim() : '',
      customer_id: null,
      customer_address_id: null,
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
      expires_at: new Date(Date.now() + 3 * 60 * 1000).toISOString(),
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

    setForm(createEmptyForm());
    setActiveView('history');
    setPublishing(false);
    setNotice(`Domicilio ${data.public_code} publicado. La oferta vence en 3 minutos.`);
  };

  if (!supabase) return <ConfigScreen />;
  if (recoveryMode && session) return <PasswordRecoveryScreen onComplete={() => { setRecoveryMode(false); window.history.replaceState({}, '', window.location.pathname); }} />;
  if (!session) return <LoginScreen />;
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

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-lockup">
          <BrandLogo />
        </div>

        <div className="sidebar-section-label">Módulo farmacia</div>
        <nav className="main-nav" aria-label="Navegación principal">
          <button className={activeView === 'publish' ? 'nav-item active' : 'nav-item'} onClick={() => setActiveView('publish')}>
            <span className="nav-icon">＋</span>
            <span>Publicar domicilio</span>
          </button>
          <button className={activeView === 'history' ? 'nav-item active' : 'nav-item'} onClick={() => setActiveView('history')}>
            <span className="nav-icon">◷</span>
            <span>Pedidos</span>
            <span className="nav-count">{deliveries.length}</span>
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
            <h1>{activeView === 'publish' ? 'Nuevo domicilio' : 'Pedidos'}</h1>
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

        {error && <div className="inline-alert error-alert" role="alert">{error}<button aria-label="Cerrar error" onClick={() => setError('')}>×</button></div>}
        {notice && <div className="inline-alert success-alert" role="status">{notice}<button aria-label="Cerrar aviso" onClick={() => setNotice('')}>×</button></div>}

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
                    <Field label="Teléfono" required><input value={form.clientPhone} onChange={(event) => setForm({ ...form, clientPhone: event.target.value.replace(/\D/g, '').slice(0, 10) })} placeholder="3000000000" inputMode="numeric" maxLength={10} autoComplete="tel" aria-describedby="client-phone-help" aria-invalid={Boolean(form.clientPhone && form.clientPhone.length !== 10)} /><small id="client-phone-help" className="field-help">{form.clientPhone ? form.clientPhone.length === 10 ? 'Número completo.' : `Número incompleto: te faltan ${10 - form.clientPhone.length}.` : 'Debe tener exactamente 10 números.'}</small></Field>
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
                    {!requiresClient && selectedServiceType.requiresCross && <><div><span>Farmacia que solicita</span><strong>{formatPharmacyOption(pharmacy)}</strong></div><div><span>Farmacia solicitada</span><strong>{form.crossStops.length === 1 && form.crossStops[0]?.destinationPharmacyCode ? pharmacyLabel(form.crossStops[0].destinationPharmacyCode) : form.crossStops.length ? `${form.crossStops.length} destinos` : 'Sin destino'}</strong></div></>}
                    {selectedServiceType.requiresPurchase && <><div><span>Lugar de compra</span><strong>{form.purchaseItems[0]?.merchant || 'Sin comercio'}</strong></div><div><span>Sede o barrio</span><strong>{form.purchaseItems[0]?.branch || 'Sin sede'}</strong></div><div><span>Total de compras</span><strong>{form.purchaseItems.length}</strong></div></>}
                    {selectedServiceType.requiresCross && <div><span>Ruta del cruce</span><strong>{crossPreview || 'Sin ruta'}</strong><small>Total de cruces: {form.crossStops.length}</small></div>}
                    {requiresPayment && <div><span>Pago</span><strong>{PAYMENT_LABELS[form.paymentMethod]} · {form.paymentAmount ? formatMoney(form.paymentAmount) : 'Sin total'}</strong>{form.paymentMethod === 'cash' && cashChange !== null && cashChange >= 0 && <small>Vuelto: {formatMoney(cashChange)}</small>}</div>}
                  </div>
                </div>

                <div className="form-actions"><span>La oferta quedará disponible durante 3 minutos.</span><button className="primary-button" disabled={publishing || !zone}>{publishing ? 'Publicando…' : 'Publicar domicilio'} <span>→</span></button></div>
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
              <div className="info-card"><div className="info-card-header"><span className="section-kicker">Actividad reciente</span><button onClick={() => setActiveView('history')}>Ver todo →</button></div>{deliveries.slice(0, 3).map((delivery) => <DeliveryRow key={delivery.id} delivery={delivery} couriers={assignedCouriers} onAssign={assignDelivery} onOpenChat={(deliveryId) => { selectChatDelivery(deliveryId); setActiveView('history'); }} onOpenEquivalent={(deliveryId) => { selectEquivalentDelivery(deliveryId); setActiveView('history'); }} />)}{deliveries.length === 0 && <EmptyActivity />}</div>
              <div className="process-card"><span className="section-kicker">Flujo registrado</span><div className="process-step"><span>1</span><div><strong>Publicas</strong><small>Oferta abierta por 3 min</small></div></div><div className="process-line" /><div className="process-step"><span>2</span><div><strong>Se acepta</strong><small>El domiciliario recibe el aviso</small></div></div><div className="process-line" /><div className="process-step"><span>3</span><div><strong>Se entrega</strong><small>El pedido queda registrado</small></div></div></div>
            </aside>
          </div>
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
            onAssign={assignDelivery}
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

function DeliveryRow({ delivery, onOpenChat, onOpenEquivalent, couriers = [], onAssign }) {
  const [assignmentOpen, setAssignmentOpen] = useState(false);
  const [selectedCourierId, setSelectedCourierId] = useState('');
  const [assigning, setAssigning] = useState(false);
  const [statusLabel, statusClass] = DELIVERY_STATUS[delivery.status] || ['Sin estado', 'status-cancelled'];
  const isTerminal = delivery.status === 'delivered' || delivery.status === 'notDelivered';
  const canAssign = Boolean(onAssign && couriers.length > 0 && ['offered', 'accepted'].includes(delivery.status));
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
  return <div className="delivery-row"><div className="delivery-row-main"><strong>{delivery.public_code || delivery.id?.slice(0, 8)}</strong><span>{delivery.client_name || 'Operación interna'} · {delivery.neighborhood || 'Sin destino'}</span></div><div className="delivery-row-side"><span className={`status-badge ${statusClass}`}>{statusLabel}</span><small>{formatDate(delivery.created_at)}</small><div className="delivery-row-actions">{onOpenChat && <button type="button" className="delivery-chat-button" onClick={() => onOpenChat(delivery.id)}>Abrir chat</button>}{canAssign && <button type="button" className="delivery-equivalent-button" onClick={() => setAssignmentOpen((open) => !open)}>{assignmentOpen ? 'Cerrar' : 'Asignar'}</button>}{onOpenEquivalent && isTerminal && <button type="button" className="delivery-equivalent-button" onClick={() => onOpenEquivalent(delivery.id)}>Equivalente</button>}</div>{assignmentOpen && <div className="delivery-assignment-controls"><label><span>Asignar a</span><select value={selectedCourierId} onChange={(event) => setSelectedCourierId(event.target.value)}><option value="">Selecciona un domiciliario</option>{couriers.map((courier) => <option key={courier.courier_id} value={courier.courier_id}>{courier.full_name || 'Domiciliario'}{courier.is_support ? ' · Apoyo general' : ''}</option>)}</select></label><button type="button" className="primary-button compact-button" disabled={!selectedCourierId || assigning} onClick={submitAssignment}>{assigning ? 'Guardando…' : 'Confirmar'}</button></div>}</div></div>;
}

function EmptyActivity() {
  return <div className="empty-activity"><span>⌁</span><p>Aún no hay domicilios publicados.</p><small>Los nuevos aparecerán aquí en tiempo real.</small></div>;
}

function HistoryView({ deliveries, pharmacy, session, profile, selectedChatDeliveryId, onOpenChat, selectedEquivalentDeliveryId, onOpenEquivalent, couriers, onAssign }) {
  const [filter, setFilter] = useState('all');
  const filtered = useMemo(() => filter === 'all' ? deliveries : deliveries.filter((delivery) => delivery.status === filter), [deliveries, filter]);
  const selectedDelivery = deliveries.find((delivery) => delivery.id === selectedChatDeliveryId) ?? null;
  const selectedEquivalentDelivery = deliveries.find((delivery) => delivery.id === selectedEquivalentDeliveryId) ?? null;
  const hasTools = Boolean(selectedDelivery || selectedEquivalentDelivery);
  return <section className="history-page"><div className="history-toolbar"><div><span className="section-kicker">Pedidos de {formatPharmacyDisplay(pharmacy)}</span><h2>Todos los pedidos</h2><p>Pedidos recibidos directamente desde Supabase. No hay registros locales.</p></div><div className="filter-row">{[['all', 'Todos'], ['offered', 'Publicados'], ['accepted', 'Aceptados'], ['delivered', 'Entregados']].map(([value, label]) => <button key={value} className={filter === value ? 'filter-button active' : 'filter-button'} onClick={() => setFilter(value)}>{label}</button>)}</div></div><div className={hasTools ? 'history-workspace has-tools' : 'history-workspace'}><div className="history-list">{filtered.map((delivery) => <DeliveryRow key={delivery.id} delivery={delivery} couriers={couriers} onAssign={onAssign} onOpenChat={onOpenChat} onOpenEquivalent={onOpenEquivalent} />)}{filtered.length === 0 && <div className="empty-history"><span>○</span><h3>No hay pedidos para mostrar</h3><p>Cuando publiques un domicilio aparecerá aquí.</p></div>}</div>{hasTools && <div className="history-tool-stack">{selectedDelivery && <DeliveryChatPanel delivery={selectedDelivery} session={session} profile={profile} onClose={() => onOpenChat(null)} />}{selectedEquivalentDelivery && <DeliveryEquivalentPanel delivery={selectedEquivalentDelivery} session={session} profile={profile} onClose={() => onOpenEquivalent(null)} />}</div>}</div></section>;
}

function equivalentInvoiceNumber(equivalent, delivery) {
  const code = equivalent?.metadata?.public_code || delivery.public_code || equivalent?.delivery_id || equivalent?.id || '';
  return String(code).replace(/^FN-/, 'JR-').toUpperCase();
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
  return <aside className="delivery-equivalent-panel" aria-label="Equivalente digital"><div className="equivalent-panel-header"><div><span className="section-kicker">Soporte registrado</span><h3>Equivalente {delivery.public_code || delivery.id?.slice(0, 8)}</h3><p>{delivery.client_name || 'Operación interna'} · {statusText}</p></div><button type="button" className="chat-close-button" onClick={onClose} aria-label="Cerrar equivalente">×</button></div><div className="equivalent-panel-body">{loading ? <p className="equivalent-empty">Cargando equivalente real…</p> : equivalentError ? <p className="equivalent-error" role="alert">{equivalentError}</p> : equivalent ? <><EquivalentReceipt equivalent={equivalent} delivery={delivery} statusText={statusText} receiptRef={receiptRef} />{equivalent.status !== 'acknowledged' && <button type="button" className="primary-button full-width" onClick={acknowledge} disabled={acknowledging}>{acknowledging ? 'Guardando recepción…' : 'Confirmar recepción en farmacia'}</button>}<div className={paymentRegistered ? 'equivalent-payment-state paid' : 'equivalent-payment-state'} role="status">{paymentRegistered ? <><strong>Pago registrado</strong><span>{formatMoney(equivalent.paid_amount ?? equivalent.amount)} · {equivalent.paid_at ? formatDate(equivalent.paid_at) : 'fecha pendiente'}</span></> : <><strong>Pago pendiente</strong><span>Registra el pago cuando la farmacia haya liquidado este soporte.</span><button type="button" className="secondary-button full-width" onClick={markPaid} disabled={markingPaid}>{markingPaid ? 'Registrando pago…' : 'Registrar pago'}</button></>}</div><div className="equivalent-download-actions"><button type="button" className="secondary-button" onClick={downloadPdf} disabled={downloadingPdf}>{downloadingPdf ? 'Preparando PDF…' : 'Descargar PDF'}</button><button type="button" className="secondary-button" onClick={downloadImage} disabled={downloadingImage}>{downloadingImage ? 'Preparando imagen…' : 'Descargar imagen'}</button></div><p className="equivalent-help">El mismo soporte queda disponible para la farmacia y el domiciliario.</p></> : null}</div></aside>;
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
    }
    setSending(false);
  };

  return <aside className="delivery-chat-panel" aria-label="Chat del domicilio"><div className="chat-panel-header"><div><span className="section-kicker">Conversación registrada</span><h3>Chat {delivery.public_code || delivery.id?.slice(0, 8)}</h3><p>{delivery.client_name || 'Operación interna'} · {delivery.status ? (DELIVERY_STATUS[delivery.status]?.[0] || delivery.status) : 'Sin estado'}</p></div><button type="button" className="chat-close-button" onClick={onClose} aria-label="Cerrar chat">×</button></div><div className="chat-participant"><span className="chat-participant-dot" /><span>Farmacia y domiciliario · el administrador también puede consultar esta conversación</span></div><div className="chat-messages" aria-live="polite">{loading ? <p className="chat-empty">Cargando mensajes reales…</p> : messages.length === 0 ? <p className="chat-empty">Todavía no hay mensajes. Escribe para coordinar este domicilio.</p> : messages.map((message) => <div key={message.id} className={message.sender_id === session?.user?.id ? 'chat-message own' : 'chat-message'}><div className="chat-message-meta"><strong>{message.sender_name || (message.sender_role === 'pharmacy' ? 'Farmacia' : 'Domiciliario')}</strong><time>{formatDate(message.created_at)}</time></div><p>{message.body}</p></div>)}</div>{chatError && <p className="chat-error" role="alert">{chatError}</p>}<form className="chat-composer" onSubmit={sendMessage}><label className="sr-only" htmlFor="pharmacy-chat-message">Mensaje</label><input ref={composerRef} id="pharmacy-chat-message" value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={`Escribe como ${profile?.full_name || 'farmacia'}`} maxLength="2000" disabled={sending} /><button type="submit" className="primary-button" disabled={sending || !draft.trim()}>{sending ? '…' : 'Enviar'}</button></form></aside>;
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
