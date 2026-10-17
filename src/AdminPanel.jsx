import { useCallback, useEffect, useMemo, useState } from 'react';

// Panel de administración de la web. Solo lee datos: las políticas RLS ya
// permiten al rol admin consultar farmacias, zonas, turnos, perfiles y
// domicilios. Crear o editar turnos, zonas y usuarios sigue en la APK.

const ADMIN_SECTIONS = [
  ['stats', 'Estadísticas'],
  ['shifts', 'Turnos'],
  ['couriers', 'Domiciliarios'],
  ['zones', 'Zonas'],
  ['pharmacies', 'Farmacias'],
];

const RANGE_PRESETS = [
  ['today', 'Hoy'],
  ['yesterday', 'Ayer'],
  ['7d', 'Últimos 7 días'],
  ['30d', 'Últimos 30 días'],
  ['month', 'Este mes'],
  ['custom', 'Personalizado'],
];

const STATUS_LABELS = {
  offered: 'Publicado',
  accepted: 'Aceptado',
  pickedUp: 'En recorrido',
  delivered: 'Entregado',
  notDelivered: 'No entregado',
  cancelled: 'Cancelado',
  expired: 'Vencido',
};

const SHIFT_STATUS = {
  scheduled: 'Programado',
  active: 'Activo',
  completed: 'Completado',
  absent: 'Ausente',
  cancelled: 'Cancelado',
};

const ACTIVE_STATUSES = new Set(['offered', 'accepted', 'pickedUp']);
const PAGE_SIZE = 1000;
const MAX_ROWS = 20000;
const WEEKDAYS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb'];

function isoDate(date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function parseIsoDate(value) {
  const [year, month, day] = String(value).split('-').map(Number);
  return new Date(year, month - 1, day);
}

function addDays(value, days) {
  const date = parseIsoDate(value);
  date.setDate(date.getDate() + days);
  return isoDate(date);
}

function presetRange(preset) {
  const today = isoDate(new Date());
  switch (preset) {
    case 'yesterday': return { from: addDays(today, -1), to: addDays(today, -1) };
    case '7d': return { from: addDays(today, -6), to: today };
    case '30d': return { from: addDays(today, -29), to: today };
    case 'month': return { from: `${today.slice(0, 8)}01`, to: today };
    default: return { from: today, to: today };
  }
}

function daysBetween(from, to) {
  const days = [];
  for (let day = from; day <= to && days.length < 400; day = addDays(day, 1)) days.push(day);
  return days;
}

// Lunes de la semana del día dado.
function weekStart(value) {
  const date = parseIsoDate(value);
  const offset = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - offset);
  return isoDate(date);
}

function formatShortDay(value) {
  const date = parseIsoDate(value);
  return `${WEEKDAYS[date.getDay()]} ${date.getDate()}/${date.getMonth() + 1}`;
}

function formatMoney(value) {
  return new Intl.NumberFormat('es-CO', {
    style: 'currency',
    currency: 'COP',
    maximumFractionDigits: 0,
  }).format(Number(value || 0));
}

function formatNumber(value) {
  return new Intl.NumberFormat('es-CO').format(Number(value || 0));
}

function formatTime(value) {
  return value ? String(value).slice(0, 5) : '—';
}

function formatZone(name) {
  const clean = String(name || '').trim();
  if (!clean) return 'Sin zona';
  return /^zona\s/i.test(clean) ? clean : `Zona ${clean}`;
}

function formatPharmacy(pharmacy, code) {
  const rawCode = String(pharmacy?.code ?? code ?? '').trim();
  const shortCode = rawCode.replace(/^FN\s*/i, '').trim();
  const name = String(pharmacy?.name ?? '').trim();
  if (!rawCode) return name || 'Farmacia';
  return name && !name.includes(shortCode) ? `FN ${shortCode} · ${name}` : `FN ${shortCode}`;
}

function errorText(error) {
  return error?.message || String(error || 'Error desconocido');
}

async function fetchAll(buildQuery) {
  const rows = [];
  for (let start = 0; start < MAX_ROWS; start += PAGE_SIZE) {
    const { data, error } = await buildQuery().range(start, start + PAGE_SIZE - 1);
    if (error) throw error;
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE_SIZE) break;
  }
  return rows;
}

function rankRows(map, catalog) {
  const rows = catalog.map((item) => ({ ...item, total: map.get(item.key)?.total ?? 0, delivered: map.get(item.key)?.delivered ?? 0 }));
  for (const [key, value] of map) {
    if (!rows.some((row) => row.key === key)) rows.push({ key, label: value.label, detail: value.detail, ...value });
  }
  return rows.sort((a, b) => b.total - a.total || a.label.localeCompare(b.label));
}

function countBy(deliveries, keyOf, labelOf) {
  const map = new Map();
  for (const delivery of deliveries) {
    const key = keyOf(delivery);
    const entry = map.get(key) ?? { total: 0, delivered: 0, label: labelOf(delivery), detail: '' };
    entry.total += 1;
    if (delivery.status === 'delivered') entry.delivered += 1;
    map.set(key, entry);
  }
  return map;
}

export default function AdminPanel({ client, profile, onSignOut, Logo, Background }) {
  const [section, setSection] = useState('stats');
  const [preset, setPreset] = useState('7d');
  const [range, setRange] = useState(() => presetRange('7d'));
  const [pharmacyFilter, setPharmacyFilter] = useState('');
  const [zoneFilter, setZoneFilter] = useState('');
  const [catalog, setCatalog] = useState({ pharmacies: [], zones: [], zonePharmacies: [], people: [], sellers: [] });
  const [deliveries, setDeliveries] = useState([]);
  const [shifts, setShifts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [updatedAt, setUpdatedAt] = useState(null);

  const choosePreset = (value) => {
    setPreset(value);
    if (value !== 'custom') setRange(presetRange(value));
  };

  const load = useCallback(async () => {
    if (!client) return;
    setLoading(true);
    setError('');
    try {
      const fromIso = parseIsoDate(range.from).toISOString();
      const toIso = parseIsoDate(addDays(range.to, 1)).toISOString();
      const [pharmacies, zones, zonePharmacies, people, sellers, deliveryRows, shiftRows] = await Promise.all([
        fetchAll(() => client.from('pharmacies').select('code, name, zone_name, address, active').order('code')),
        fetchAll(() => client.from('zones').select('id, name, active, reference').order('name')),
        fetchAll(() => client.from('zone_pharmacies').select('zone_id, pharmacy_code')),
        fetchAll(() => client.from('profiles').select('id, full_name, role, pharmacy_code, phone, active').order('full_name')),
        fetchAll(() => client.from('pharmacy_profiles').select('id, pharmacy_code, display_name, username, profile_role, active').order('display_name')),
        fetchAll(() => client
          .from('deliveries')
          .select('id, public_code, pharmacy_code, zone_id, status, service_type, payment_amount, courier_earnings, accepted_courier_id, pharmacy_profile_id, created_by, created_at, delivered_at, cancelled_at')
          .gte('created_at', fromIso)
          .lt('created_at', toIso)
          .order('created_at', { ascending: true })),
        fetchAll(() => client
          .from('shifts')
          .select('id, courier_id, pharmacy_code, zone_id, scheduled_for, starts_at, ends_at, is_double, status, assignment_type')
          .gte('scheduled_for', range.from)
          .lte('scheduled_for', range.to)
          .order('scheduled_for', { ascending: false })
          .order('starts_at', { ascending: true })),
      ]);
      setCatalog({ pharmacies, zones, zonePharmacies, people, sellers });
      setDeliveries(deliveryRows);
      setShifts(shiftRows);
      setUpdatedAt(new Date());
    } catch (loadError) {
      setError(`No se pudieron cargar los datos: ${errorText(loadError)}`);
    } finally {
      setLoading(false);
    }
  }, [client, range.from, range.to]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => { void load(); }, 60000);
    return () => window.clearInterval(timer);
  }, [load]);

  const lookups = useMemo(() => ({
    pharmacy: new Map(catalog.pharmacies.map((item) => [item.code, item])),
    zone: new Map(catalog.zones.map((item) => [item.id, item])),
    person: new Map(catalog.people.map((item) => [item.id, item])),
    seller: new Map(catalog.sellers.map((item) => [item.id, item])),
  }), [catalog]);

  const zonePharmacyCodes = useMemo(() => {
    if (!zoneFilter) return null;
    return new Set(catalog.zonePharmacies.filter((row) => row.zone_id === zoneFilter).map((row) => row.pharmacy_code));
  }, [catalog.zonePharmacies, zoneFilter]);

  const filteredDeliveries = useMemo(() => deliveries.filter((delivery) => {
    if (pharmacyFilter && delivery.pharmacy_code !== pharmacyFilter) return false;
    if (zoneFilter && delivery.zone_id !== zoneFilter && !zonePharmacyCodes?.has(delivery.pharmacy_code)) return false;
    return true;
  }), [deliveries, pharmacyFilter, zoneFilter, zonePharmacyCodes]);

  const filteredShifts = useMemo(() => shifts.filter((shift) => {
    if (pharmacyFilter && shift.pharmacy_code !== pharmacyFilter && shift.assignment_type !== 'support') return false;
    if (zoneFilter && shift.zone_id !== zoneFilter && shift.assignment_type !== 'support') return false;
    return true;
  }), [shifts, pharmacyFilter, zoneFilter]);

  const title = ADMIN_SECTIONS.find(([key]) => key === section)?.[1] ?? 'Administración';
  const firstName = (profile?.full_name || 'Administrador').trim().split(/\s+/)[0];

  return (
    <div className="app-shell admin-shell">
      <aside className="sidebar">
        <div className="brand-lockup">{Logo ? <Logo /> : <strong>farmanorte</strong>}</div>
        <div className="sidebar-section-label">Módulo administración</div>
        <nav className="main-nav" aria-label="Navegación de administración">
          {ADMIN_SECTIONS.map(([key, label]) => (
            <button key={key} type="button" className={section === key ? 'nav-item active' : 'nav-item'} onClick={() => setSection(key)} aria-current={section === key ? 'page' : undefined}>
              <span className="nav-icon"><AdminIcon name={key} /></span>
              <span>{label}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <button type="button" className="sign-out-link" onClick={onSignOut}>Cerrar sesión <span>↗</span></button>
          <div className="connection-card">
            <span className="pulse-dot" />
            <div>
              <strong>Administrador</strong>
              <span>{updatedAt ? `Actualizado ${updatedAt.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' })}` : 'Cargando…'}</span>
            </div>
          </div>
        </div>
      </aside>

      <main className="main-content">
        {Background ? <Background /> : null}
        <header className="topbar">
          <div>
            <p className="welcome-line">Bienvenido, {firstName}</p>
            <p className="eyebrow">Panel de administración</p>
            <h1>{title}</h1>
          </div>
          <div className="operator-info">
            <div className="operator-avatar">{firstName.slice(0, 1).toUpperCase()}</div>
            <div><strong>{profile?.full_name || 'Administrador'}</strong><span>Todas las farmacias</span></div>
          </div>
        </header>

        <section className="admin-filters" aria-label="Filtros">
          <div className="admin-range-chips" role="group" aria-label="Periodo">
            {RANGE_PRESETS.map(([key, label]) => (
              <button key={key} type="button" className={preset === key ? 'admin-chip active' : 'admin-chip'} onClick={() => choosePreset(key)}>{label}</button>
            ))}
          </div>
          <div className="admin-filter-fields">
            {preset === 'custom' && <>
              <label><span>Desde</span><input type="date" value={range.from} max={range.to} onChange={(event) => event.target.value && setRange((current) => ({ ...current, from: event.target.value }))} /></label>
              <label><span>Hasta</span><input type="date" value={range.to} min={range.from} onChange={(event) => event.target.value && setRange((current) => ({ ...current, to: event.target.value }))} /></label>
            </>}
            <label><span>Farmacia</span>
              <select value={pharmacyFilter} onChange={(event) => setPharmacyFilter(event.target.value)}>
                <option value="">Todas</option>
                {catalog.pharmacies.map((item) => <option key={item.code} value={item.code}>{formatPharmacy(item)}</option>)}
              </select>
            </label>
            <label><span>Zona</span>
              <select value={zoneFilter} onChange={(event) => setZoneFilter(event.target.value)}>
                <option value="">Todas</option>
                {catalog.zones.map((item) => <option key={item.id} value={item.id}>{formatZone(item.name)}</option>)}
              </select>
            </label>
            <button type="button" className="secondary-button compact-button" onClick={() => void load()} disabled={loading}>{loading ? 'Cargando…' : 'Actualizar'}</button>
          </div>
        </section>

        {error && <div className="inline-alert error-alert" role="alert">{error}</div>}
        {deliveries.length >= MAX_ROWS && <div className="inline-alert" role="status">El periodo tiene más de {formatNumber(MAX_ROWS)} domicilios; se muestran los primeros. Reduce el rango de fechas.</div>}

        {section === 'stats' && <AdminStats range={range} deliveries={filteredDeliveries} lookups={lookups} catalog={catalog} pharmacyFilter={pharmacyFilter} zonePharmacyCodes={zonePharmacyCodes} loading={loading} />}
        {section === 'shifts' && <AdminShifts shifts={filteredShifts} lookups={lookups} loading={loading} />}
        {section === 'couriers' && <AdminCouriers catalog={catalog} deliveries={filteredDeliveries} shifts={shifts} lookups={lookups} />}
        {section === 'zones' && <AdminZones catalog={catalog} shifts={shifts} deliveries={deliveries} lookups={lookups} />}
        {section === 'pharmacies' && <AdminPharmacies catalog={catalog} deliveries={deliveries} lookups={lookups} />}
      </main>
    </div>
  );
}

function AdminStats({ range, deliveries, lookups, catalog, pharmacyFilter, zonePharmacyCodes, loading }) {
  const summary = useMemo(() => {
    const result = { total: deliveries.length, delivered: 0, active: 0, cancelled: 0, failed: 0, value: 0, earnings: 0 };
    for (const delivery of deliveries) {
      if (delivery.status === 'delivered') {
        result.delivered += 1;
        result.value += Number(delivery.payment_amount || 0);
        result.earnings += Number(delivery.courier_earnings || 0);
      } else if (ACTIVE_STATUSES.has(delivery.status)) result.active += 1;
      else if (delivery.status === 'cancelled' || delivery.status === 'expired') result.cancelled += 1;
      else if (delivery.status === 'notDelivered') result.failed += 1;
    }
    return result;
  }, [deliveries]);

  const days = useMemo(() => {
    const map = new Map(daysBetween(range.from, range.to).map((day) => [day, { day, total: 0, delivered: 0 }]));
    for (const delivery of deliveries) {
      const entry = map.get(isoDate(new Date(delivery.created_at)));
      if (!entry) continue;
      entry.total += 1;
      if (delivery.status === 'delivered') entry.delivered += 1;
    }
    return [...map.values()];
  }, [deliveries, range.from, range.to]);

  const weeks = useMemo(() => {
    const map = new Map();
    for (const day of days) {
      const key = weekStart(day.day);
      const entry = map.get(key) ?? { week: key, total: 0, delivered: 0 };
      entry.total += day.total;
      entry.delivered += day.delivered;
      map.set(key, entry);
    }
    return [...map.values()];
  }, [days]);

  const pharmacyRanking = useMemo(() => {
    const visible = catalog.pharmacies.filter((item) => item.active !== false
      && (!pharmacyFilter || item.code === pharmacyFilter)
      && (!zonePharmacyCodes || zonePharmacyCodes.has(item.code)));
    const map = countBy(deliveries, (delivery) => delivery.pharmacy_code, (delivery) => formatPharmacy(lookups.pharmacy.get(delivery.pharmacy_code), delivery.pharmacy_code));
    return rankRows(map, visible.map((item) => ({ key: item.code, label: formatPharmacy(item), detail: formatZone(item.zone_name) })));
  }, [catalog.pharmacies, deliveries, lookups, pharmacyFilter, zonePharmacyCodes]);

  const sellerRanking = useMemo(() => {
    const visiblePharmacies = new Set(pharmacyRanking.map((row) => row.key));
    const sellers = catalog.sellers.filter((item) => item.active !== false && visiblePharmacies.has(item.pharmacy_code));
    // Los domicilios hechos con la cuenta general (sin perfil) no compiten en
    // el ranking; se informan aparte.
    const map = countBy(
      deliveries.filter((delivery) => delivery.pharmacy_profile_id),
      (delivery) => delivery.pharmacy_profile_id,
      (delivery) => lookups.seller.get(delivery.pharmacy_profile_id)?.display_name || 'Perfil retirado',
    );
    for (const [key, entry] of map) {
      const seller = lookups.seller.get(key);
      entry.detail = seller ? `${seller.profile_role === 'cajero' ? 'Cajero' : 'Vendedor'} · ${formatPharmacy(lookups.pharmacy.get(seller.pharmacy_code), seller.pharmacy_code)}` : 'Perfil retirado';
    }
    return rankRows(map, sellers.map((item) => ({
      key: item.id,
      label: item.display_name,
      detail: `${item.profile_role === 'cajero' ? 'Cajero' : 'Vendedor'} · ${formatPharmacy(lookups.pharmacy.get(item.pharmacy_code), item.pharmacy_code)}`,
    })));
  }, [catalog.sellers, deliveries, lookups, pharmacyRanking]);

  const courierRanking = useMemo(() => {
    const map = countBy(
      deliveries.filter((delivery) => delivery.accepted_courier_id),
      (delivery) => delivery.accepted_courier_id,
      (delivery) => lookups.person.get(delivery.accepted_courier_id)?.full_name || 'Domiciliario',
    );
    const couriers = catalog.people.filter((item) => item.role === 'courier' && item.active !== false);
    return rankRows(map, couriers.map((item) => ({ key: item.id, label: item.full_name, detail: item.phone || '' })));
  }, [catalog.people, deliveries, lookups]);

  const withoutSeller = deliveries.filter((delivery) => !delivery.pharmacy_profile_id).length;

  const serviceTypes = useMemo(() => {
    const map = countBy(deliveries, (delivery) => delivery.service_type || 'Sin tipo', (delivery) => delivery.service_type || 'Sin tipo');
    return rankRows(map, []);
  }, [deliveries]);

  const maxDay = Math.max(1, ...days.map((day) => day.total));
  const maxWeek = Math.max(1, ...weeks.map((week) => week.total));
  const rate = summary.total ? Math.round((summary.delivered / summary.total) * 100) : 0;

  return <div className="admin-stack">
    <div className="admin-kpis" role="list">
      <AdminKpi label="Domicilios" value={formatNumber(summary.total)} hint={loading ? 'Cargando…' : `${days.length} ${days.length === 1 ? 'día' : 'días'}`} />
      <AdminKpi label="Entregados" value={formatNumber(summary.delivered)} hint={`${rate}% del total`} tone="ok" />
      <AdminKpi label="En curso" value={formatNumber(summary.active)} hint="Publicados, aceptados o en recorrido" />
      <AdminKpi label="Cancelados o vencidos" value={formatNumber(summary.cancelled)} hint={summary.failed ? `${summary.failed} no entregados` : 'Sin no entregados'} tone="danger" />
      <AdminKpi label="Valor entregado" value={formatMoney(summary.value)} hint="Suma de pagos de lo entregado" />
      <AdminKpi label="Ganancia domiciliarios" value={formatMoney(summary.earnings)} hint="De los domicilios entregados" />
    </div>

    <section className="form-card admin-card">
      <div className="card-heading"><div><span className="section-kicker">Volumen</span><h2>Domicilios por día</h2></div><span className="admin-legend"><i className="legend-total" /> Total <i className="legend-ok" /> Entregados</span></div>
      {days.length === 0 ? <p className="admin-empty">Sin días en el periodo.</p> : <div className="admin-bars" style={{ '--bar-count': days.length }}>
        {days.map((day) => <div key={day.day} className="admin-bar" title={`${formatShortDay(day.day)}: ${day.total} domicilios, ${day.delivered} entregados`}>
          <span className="admin-bar-value">{day.total || ''}</span>
          <div className="admin-bar-track">
            <div className="admin-bar-fill" style={{ height: `${(day.total / maxDay) * 100}%` }}>
              <div className="admin-bar-ok" style={{ height: day.total ? `${(day.delivered / day.total) * 100}%` : 0 }} />
            </div>
          </div>
          <span className="admin-bar-label">{days.length > 16 ? parseIsoDate(day.day).getDate() : formatShortDay(day.day)}</span>
        </div>)}
      </div>}
    </section>

    <div className="admin-grid-2">
      <section className="form-card admin-card">
        <div className="card-heading"><div><span className="section-kicker">Volumen</span><h2>Domicilios por semana</h2></div></div>
        {weeks.length === 0 ? <p className="admin-empty">Sin semanas en el periodo.</p> : <ul className="admin-hbars">
          {weeks.map((week) => <li key={week.week}>
            <span className="admin-hbar-label">Semana del {formatShortDay(week.week)}</span>
            <span className="admin-hbar-track"><span style={{ width: `${(week.total / maxWeek) * 100}%` }} /></span>
            <strong>{formatNumber(week.total)}</strong>
          </li>)}
        </ul>}
      </section>
      <section className="form-card admin-card">
        <div className="card-heading"><div><span className="section-kicker">Mezcla</span><h2>Tipo de servicio</h2></div></div>
        {serviceTypes.length === 0 ? <p className="admin-empty">Sin domicilios en el periodo.</p> : <ul className="admin-hbars">
          {serviceTypes.slice(0, 8).map((row) => <li key={row.key}>
            <span className="admin-hbar-label">{row.label}</span>
            <span className="admin-hbar-track"><span style={{ width: `${(row.total / Math.max(1, serviceTypes[0].total)) * 100}%` }} /></span>
            <strong>{formatNumber(row.total)}</strong>
          </li>)}
        </ul>}
      </section>
    </div>

    <AdminRanking title="Farmacias" kicker="Ranking" rows={pharmacyRanking} unit="domicilios" />
    <AdminRanking title="Vendedores y cajeros" kicker="Ranking" rows={sellerRanking} unit="domicilios" note={withoutSeller ? `${formatNumber(withoutSeller)} domicilios se publicaron con la cuenta general de la farmacia, sin elegir vendedor; no cuentan en este ranking.` : ''} />
    <AdminRanking title="Domiciliarios" kicker="Ranking" rows={courierRanking} unit="aceptados" />
  </div>;
}

function AdminKpi({ label, value, hint, tone }) {
  return <div className={tone ? `admin-kpi admin-kpi-${tone}` : 'admin-kpi'} role="listitem">
    <span>{label}</span>
    <strong>{value}</strong>
    <small>{hint}</small>
  </div>;
}

function AdminRanking({ title, kicker, rows, unit, note = '' }) {
  const [showAll, setShowAll] = useState(false);
  const top = rows.slice(0, 5);
  const bottom = rows.length > 5 ? rows.slice(-5).reverse() : [];
  const max = Math.max(1, rows[0]?.total ?? 0);
  const renderRow = (row, index, prefix) => <li key={`${prefix}-${row.key}`}>
    <span className="admin-rank-pos">{prefix === 'bottom' ? rows.length - index : index + 1}</span>
    <span className="admin-rank-name"><strong>{row.label}</strong>{row.detail && <small>{row.detail}</small>}</span>
    <span className="admin-hbar-track"><span style={{ width: `${(row.total / max) * 100}%` }} /></span>
    <span className="admin-rank-total"><strong>{formatNumber(row.total)}</strong><small>{row.delivered} entregados</small></span>
  </li>;
  return <section className="form-card admin-card">
    <div className="card-heading">
      <div><span className="section-kicker">{kicker}</span><h2>{title}</h2></div>
      {rows.length > 10 && <button type="button" className="secondary-button compact-button" onClick={() => setShowAll((value) => !value)}>{showAll ? 'Ver resumen' : `Ver los ${rows.length}`}</button>}
    </div>
    {note && <p className="page-intro">{note}</p>}
    {rows.length === 0 ? <p className="admin-empty">Sin datos en el periodo.</p> : showAll || rows.length <= 10
      ? <ol className="admin-rank">{rows.map((row, index) => renderRow(row, index, 'all'))}</ol>
      : <div className="admin-grid-2">
        <div><h3 className="admin-subtitle">Más {unit}</h3><ol className="admin-rank">{top.map((row, index) => renderRow(row, index, 'top'))}</ol></div>
        <div><h3 className="admin-subtitle">Menos {unit}</h3><ol className="admin-rank">{bottom.map((row, index) => renderRow(row, index, 'bottom'))}</ol></div>
      </div>}
  </section>;
}

function shiftZoneLabel(shift, lookups) {
  if (shift.assignment_type === 'support') {
    return shift.zone_id ? `Apoyo · ${formatZone(lookups.zone.get(shift.zone_id)?.name)}` : 'Apoyo general';
  }
  return formatZone(lookups.zone.get(shift.zone_id)?.name);
}

function AdminShifts({ shifts, lookups, loading }) {
  const [query, setQuery] = useState('');
  const [type, setType] = useState('');
  const rows = useMemo(() => {
    const text = query.trim().toLowerCase();
    return shifts.filter((shift) => {
      if (type && (shift.assignment_type || 'zone') !== type) return false;
      if (!text) return true;
      const courier = lookups.person.get(shift.courier_id)?.full_name || '';
      const pharmacy = formatPharmacy(lookups.pharmacy.get(shift.pharmacy_code), shift.pharmacy_code);
      return `${courier} ${pharmacy} ${shiftZoneLabel(shift, lookups)}`.toLowerCase().includes(text);
    });
  }, [shifts, lookups, query, type]);
  const byDay = useMemo(() => {
    const map = new Map();
    for (const shift of rows) map.set(shift.scheduled_for, [...(map.get(shift.scheduled_for) ?? []), shift]);
    return [...map.entries()];
  }, [rows]);
  const today = isoDate(new Date());

  return <section className="form-card admin-card">
    <div className="card-heading">
      <div><span className="section-kicker">Programación</span><h2>Turnos programados</h2></div>
      <div className="admin-inline-filters">
        <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar domiciliario, farmacia o zona" aria-label="Buscar turnos" />
        <select value={type} onChange={(event) => setType(event.target.value)} aria-label="Tipo de turno">
          <option value="">Todos</option>
          <option value="zone">De zona</option>
          <option value="support">Apoyo</option>
        </select>
      </div>
    </div>
    <p className="page-intro">{formatNumber(rows.length)} turnos en el periodo. Los turnos de apoyo cubren cualquier farmacia, por eso aparecen aunque filtres una farmacia o zona.</p>
    {loading && rows.length === 0 ? <p className="admin-empty">Cargando turnos…</p> : byDay.length === 0 ? <p className="admin-empty">No hay turnos en el periodo.</p> : byDay.map(([day, items]) => <div key={day} className="admin-day-group">
      <h3 className="admin-subtitle">{formatShortDay(day)}{day === today ? ' · hoy' : ''} <small>{items.length} turnos</small></h3>
      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead><tr><th>Horario</th><th>Domiciliario</th><th>Farmacia</th><th>Zona</th><th>Estado</th></tr></thead>
          <tbody>{items.map((shift) => <tr key={shift.id}>
            <td>{formatTime(shift.starts_at)}–{formatTime(shift.ends_at)}{shift.is_double ? ' · doble' : ''}</td>
            <td>{lookups.person.get(shift.courier_id)?.full_name || 'Domiciliario'}</td>
            <td>{shift.assignment_type === 'support' ? 'Todas' : formatPharmacy(lookups.pharmacy.get(shift.pharmacy_code), shift.pharmacy_code)}</td>
            <td><span className={shift.assignment_type === 'support' ? 'admin-tag admin-tag-support' : 'admin-tag'}>{shiftZoneLabel(shift, lookups)}</span></td>
            <td>{SHIFT_STATUS[shift.status] || shift.status}</td>
          </tr>)}</tbody>
        </table>
      </div>
    </div>)}
  </section>;
}

function AdminCouriers({ catalog, deliveries, shifts, lookups }) {
  const [showInactive, setShowInactive] = useState(false);
  const today = isoDate(new Date());
  const rows = useMemo(() => {
    const stats = new Map();
    for (const delivery of deliveries) {
      if (!delivery.accepted_courier_id) continue;
      const entry = stats.get(delivery.accepted_courier_id) ?? { total: 0, delivered: 0, earnings: 0 };
      entry.total += 1;
      if (delivery.status === 'delivered') {
        entry.delivered += 1;
        entry.earnings += Number(delivery.courier_earnings || 0);
      }
      stats.set(delivery.accepted_courier_id, entry);
    }
    return catalog.people
      .filter((person) => person.role === 'courier' && (showInactive || person.active !== false))
      .map((person) => ({
        person,
        stats: stats.get(person.id) ?? { total: 0, delivered: 0, earnings: 0 },
        todayShifts: shifts.filter((shift) => shift.courier_id === person.id && shift.scheduled_for === today),
      }))
      .sort((a, b) => b.stats.total - a.stats.total || a.person.full_name.localeCompare(b.person.full_name));
  }, [catalog.people, deliveries, shifts, showInactive, today]);

  return <section className="form-card admin-card">
    <div className="card-heading">
      <div><span className="section-kicker">Equipo</span><h2>Domiciliarios</h2></div>
      <label className="admin-toggle"><input type="checkbox" checked={showInactive} onChange={(event) => setShowInactive(event.target.checked)} /> Mostrar inactivos</label>
    </div>
    <p className="page-intro">{rows.length} domiciliarios. Los números son del periodo y filtros elegidos; el turno es el de hoy.</p>
    <div className="admin-table-wrap">
      <table className="admin-table">
        <thead><tr><th>Domiciliario</th><th>Teléfono</th><th>Turno de hoy</th><th>Aceptados</th><th>Entregados</th><th>Ganancia</th></tr></thead>
        <tbody>{rows.map(({ person, stats, todayShifts }) => <tr key={person.id} className={person.active === false ? 'admin-row-muted' : undefined}>
          <td><strong>{person.full_name}</strong>{person.active === false && <small> · inactivo</small>}</td>
          <td>{person.phone || '—'}</td>
          <td>{todayShifts.length === 0 ? <span className="admin-muted">Sin turno</span> : todayShifts.map((shift) => <span key={shift.id} className={shift.assignment_type === 'support' ? 'admin-tag admin-tag-support' : 'admin-tag'}>{formatTime(shift.starts_at)}–{formatTime(shift.ends_at)} · {shiftZoneLabel(shift, lookups)}</span>)}</td>
          <td>{formatNumber(stats.total)}</td>
          <td>{formatNumber(stats.delivered)}</td>
          <td>{formatMoney(stats.earnings)}</td>
        </tr>)}</tbody>
      </table>
    </div>
  </section>;
}

function AdminZones({ catalog, shifts, deliveries, lookups }) {
  const today = isoDate(new Date());
  const rows = useMemo(() => catalog.zones.map((zone) => {
    const codes = catalog.zonePharmacies.filter((row) => row.zone_id === zone.id).map((row) => row.pharmacy_code);
    const todayShifts = shifts.filter((shift) => shift.zone_id === zone.id && shift.scheduled_for === today);
    const total = deliveries.filter((delivery) => delivery.zone_id === zone.id).length;
    return { zone, codes, todayShifts, total };
  }), [catalog.zones, catalog.zonePharmacies, shifts, deliveries, today]);
  const supportToday = shifts.filter((shift) => shift.assignment_type === 'support' && shift.scheduled_for === today);

  return <div className="admin-stack">
    <section className="form-card admin-card">
      <div className="card-heading"><div><span className="section-kicker">Cobertura</span><h2>Apoyo general de hoy</h2></div></div>
      {supportToday.length === 0 ? <p className="admin-empty">No hay turnos de apoyo hoy.</p> : <div className="admin-tag-list">{supportToday.map((shift) => <span key={shift.id} className="admin-tag admin-tag-support">{lookups.person.get(shift.courier_id)?.full_name || 'Domiciliario'} · {formatTime(shift.starts_at)}–{formatTime(shift.ends_at)}</span>)}</div>}
    </section>
    <div className="admin-zone-grid">
      {rows.map(({ zone, codes, todayShifts, total }) => <section key={zone.id} className={zone.active === false ? 'form-card admin-card admin-row-muted' : 'form-card admin-card'}>
        <div className="card-heading"><div><span className="section-kicker">{zone.active === false ? 'Inactiva' : 'Zona'}</span><h2>{formatZone(zone.name)}</h2></div><strong className="admin-zone-total">{formatNumber(total)}<small> domicilios</small></strong></div>
        {zone.reference && <p className="page-intro">{zone.reference}</p>}
        <h3 className="admin-subtitle">Farmacias</h3>
        {codes.length === 0 ? <p className="admin-empty">Sin farmacias asignadas.</p> : <div className="admin-tag-list">{codes.map((code) => <span key={code} className="admin-tag">{formatPharmacy(lookups.pharmacy.get(code), code)}</span>)}</div>}
        <h3 className="admin-subtitle">Turnos de hoy</h3>
        {todayShifts.length === 0 ? <p className="admin-empty">Sin domiciliario de zona hoy.</p> : <div className="admin-tag-list">{todayShifts.map((shift) => <span key={shift.id} className="admin-tag">{lookups.person.get(shift.courier_id)?.full_name || 'Domiciliario'} · {formatTime(shift.starts_at)}–{formatTime(shift.ends_at)}</span>)}</div>}
      </section>)}
    </div>
  </div>;
}

function AdminPharmacies({ catalog, deliveries, lookups }) {
  const rows = useMemo(() => catalog.pharmacies.map((pharmacy) => {
    const own = deliveries.filter((delivery) => delivery.pharmacy_code === pharmacy.code);
    return {
      pharmacy,
      sellers: catalog.sellers.filter((seller) => seller.pharmacy_code === pharmacy.code && seller.active !== false),
      accounts: catalog.people.filter((person) => person.role === 'pharmacy' && person.pharmacy_code === pharmacy.code),
      zones: catalog.zonePharmacies.filter((row) => row.pharmacy_code === pharmacy.code).map((row) => formatZone(lookups.zone.get(row.zone_id)?.name)),
      total: own.length,
      delivered: own.filter((delivery) => delivery.status === 'delivered').length,
    };
  }), [catalog, deliveries, lookups]);

  return <section className="form-card admin-card">
    <div className="card-heading"><div><span className="section-kicker">Red</span><h2>Farmacias</h2></div></div>
    <p className="page-intro">{rows.length} farmacias. Los domicilios son del periodo elegido.</p>
    <div className="admin-table-wrap">
      <table className="admin-table">
        <thead><tr><th>Farmacia</th><th>Zona</th><th>Dirección</th><th>Vendedores y cajeros</th><th>Domicilios</th><th>Entregados</th></tr></thead>
        <tbody>{rows.map(({ pharmacy, sellers, accounts, zones, total, delivered }) => <tr key={pharmacy.code} className={pharmacy.active === false ? 'admin-row-muted' : undefined}>
          <td><strong>{formatPharmacy(pharmacy)}</strong>{pharmacy.active === false && <small> · inactiva</small>}{accounts.length > 0 && <small className="admin-block">{accounts.length} {accounts.length === 1 ? 'cuenta' : 'cuentas'} de acceso</small>}</td>
          <td>{zones.length ? zones.join(', ') : formatZone(pharmacy.zone_name)}</td>
          <td>{pharmacy.address || '—'}</td>
          <td>{sellers.length === 0 ? <span className="admin-muted">Sin perfiles</span> : sellers.map((seller) => <span key={seller.id} className="admin-tag">{seller.display_name} · {seller.profile_role === 'cajero' ? 'Cajero' : 'Vendedor'}</span>)}</td>
          <td>{formatNumber(total)}</td>
          <td>{formatNumber(delivered)}</td>
        </tr>)}</tbody>
      </table>
    </div>
  </section>;
}

function AdminIcon({ name }) {
  const paths = {
    stats: <><path d="M4.5 19.5h15" /><path d="M7 16v-5M12 16V7M17 16v-8" /></>,
    shifts: <><rect x="4.5" y="5.5" width="15" height="14" rx="2" /><path d="M8 3.5v4M16 3.5v4M4.5 9.5h15" /></>,
    couriers: <><circle cx="12" cy="8" r="3.5" /><path d="M5 19.5c1.2-3.6 3.6-5.2 7-5.2s5.8 1.6 7 5.2" /></>,
    zones: <><path d="M12 20.5s6-5.4 6-10.2a6 6 0 1 0-12 0c0 4.8 6 10.2 6 10.2Z" /><circle cx="12" cy="10.3" r="2.2" /></>,
    pharmacies: <><path d="M4.5 9.5 12 4l7.5 5.5v10h-15z" /><path d="M12 11v6M9 14h6" /></>,
  };
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}
