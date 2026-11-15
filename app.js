// Panel de activos en vivo: todo corre en el navegador con los datos públicos de Binance (sin clave).
// Las fórmulas son las mismas del escáner en Python (escaner/metricas.py).
const REST = 'https://data-api.binance.vision/api/v3';
const ESTABLES = new Set(['USDC', 'FDUSD', 'TUSD', 'DAI', 'USDP', 'BUSD', 'EUR', 'TRY', 'BRL', 'ARS', 'GBP', 'AEUR', 'EURI', 'USD1',
  'XUSD', 'BFUSD', 'USDE', 'PAXG', 'RLUSD']);
const NO_CRIPTO = new Set(['XAUT', 'PAXG', 'NVDAB', 'MSTRB', 'CRCLB', 'TSLAB', 'AAPLB', 'COINB', 'HOODB', 'SPYB', 'QQQB', 'GOOGLB',
  'AMZNB', 'METAB', 'MSFTB', 'AMDB', 'PLTRB']);
const VENTANA = 3;
const PESOS = {volumen: 0.30, compra: 0.30, momentum: 0.20, aceleracion: 0.10, libro: 0.10};

const $ = id => document.getElementById(id);
const esc = t => String(t).replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
const guardar = (k, v) => { try { localStorage.setItem('panel.' + k, v); } catch (e) {} };
const leer = k => { try { return localStorage.getItem('panel.' + k); } catch (e) { return null; } };

async function get(ruta, params = {}) {
  const url = REST + '/' + ruta + '?' + new URLSearchParams(params);
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    } catch (e) {
      if (i === 2) throw e;
      await new Promise(ok => setTimeout(ok, 800 * (i + 1)));
    }
  }
}

// ---------------------------------------------------------------- datos
async function universo(n, minimo = 5e6) {
  const filas = await get('ticker/24hr', {type: 'MINI'});
  const out = [];
  for (const t of filas) {
    const s = t.symbol;
    if (!s.endsWith('USDT')) continue;
    const base = s.slice(0, -4);
    if (ESTABLES.has(base) || NO_CRIPTO.has(base) || /(UP|DOWN|BULL|BEAR)$/.test(base)) continue;
    const vol = +t.quoteVolume, precio = +t.lastPrice, alto = +t.highPrice, bajo = +t.lowPrice;
    if (precio > 0.97 && precio < 1.03 && (alto - bajo) / precio < 0.01) continue;   // estables que no están en la lista
    if (vol >= minimo && precio > 0) out.push([s, vol]);
  }
  out.sort((a, b) => b[1] - a[1]);
  return out.slice(0, n).map(x => x[0]);
}

async function velas(simbolo, intervalo = '5m', limite = 60) {
  const k = await get('klines', {symbol: simbolo, interval: intervalo, limit: limite});
  return k.map(x => ({maximo: +x[2], minimo: +x[3], cierre: +x[4], vol: +x[7], compra: +x[10]}));
}

async function tickers(simbolos) {
  const filas = await get('ticker/24hr', {symbols: JSON.stringify(simbolos), type: 'MINI'});
  const out = {};
  for (const t of filas) out[t.symbol] = {precio: +t.lastPrice, var: (+t.lastPrice / +t.openPrice - 1) * 100, vol24: +t.quoteVolume};
  return out;
}

// ---------------------------------------------------------------- métricas (igual que metricas.py)
const suma = a => a.reduce((x, y) => x + y, 0);
function volumenAnomalo(v, ventana = VENTANA, historia = 36) {
  if (v.length < ventana + 6) return [NaN, NaN];
  const reciente = suma(v.slice(-ventana));
  const antes = v.slice(-(ventana + historia), -ventana), bloques = [];
  for (let i = 0; i + ventana <= antes.length; i += ventana) bloques.push(suma(antes.slice(i, i + ventana)));
  const media = suma(bloques) / bloques.length;
  const desvio = Math.sqrt(suma(bloques.map(b => (b - media) ** 2)) / bloques.length);
  return [media > 0 ? reciente / media : NaN, desvio > 0 ? (reciente - media) / desvio : 0];
}
function resumen(simbolo, d) {
  const c = d.map(x => x.cierre), u = d.slice(-VENTANA), total = suma(u.map(x => x.vol)), compra = suma(u.map(x => x.compra));
  const [volx, volz] = volumenAnomalo(d.map(x => x.vol));
  const pc = total > 0 ? compra / total : NaN;
  const mom = atras => c.length > atras ? (c[c.length - 1] / c[c.length - 1 - atras] - 1) * 100 : NaN;
  const n = c.length, acel = n > 2 * VENTANA
    ? ((c[n - 1] / c[n - 1 - VENTANA] - 1) - (c[n - 1 - VENTANA] / c[n - 1 - 2 * VENTANA] - 1)) * 100 : NaN;
  const f = {activo: simbolo.replace(/USDT$/, ''), simbolo, volx, volz, compra: isNaN(pc) ? NaN : pc * 100,
             flujo: compra - (total - compra), mom15: mom(VENTANA), mom1h: mom(4 * VENTANA), acel, libro: NaN};
  f.puntaje = puntaje(f);
  return f;
}
const acotar = (x, escala) => (x == null || isNaN(x)) ? 0 : Math.tanh(x / escala);
function puntaje(f) {
  const compra = isNaN(f.compra) ? 50 : f.compra, dir = compra >= 50 ? 1 : -1;
  const partes = {
    volumen: dir * Math.max(0, acotar(f.volz, 3)), compra: acotar((compra - 50) / 100, 0.1),
    momentum: acotar(f.mom15, 2), aceleracion: acotar(f.acel, 1), libro: acotar(f.libro, 0.3),
  };
  return Math.round(1000 * Object.keys(PESOS).reduce((a, k) => a + PESOS[k] * partes[k], 0)) / 10;
}

async function enParalelo(items, fn, hilos = 8) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({length: hilos}, async () => {
    while (i < items.length) { const k = i++; try { out[k] = await fn(items[k]); } catch (e) { out[k] = null; } }
  }));
  return out;
}

// ---------------------------------------------------------------- estado y escaneo
let pares = [], paresHora = 0, datos = [], ultimaN = 0;
const cfg = {n: +(leer('n') || 30), orden: leer('orden') || 'puntaje', color: leer('color') || 'puntaje',
             filas: +(leer('filas') || 8), ref: +(leer('ref') || 15), solapa: leer('solapa') || 'monitor', par: leer('par') || 'BTCUSDT'};

async function escanear() {
  if (!pares.length || Date.now() - paresHora > 5 * 60 * 1000 || ultimaN !== cfg.n) {
    pares = await universo(cfg.n); paresHora = Date.now(); ultimaN = cfg.n; llenarPares();
  }
  const [presion, dia] = await Promise.all([enParalelo(pares, async s => resumen(s, await velas(s))), tickers(pares)]);
  datos = presion.filter(Boolean).map(f => ({...f, ...(dia[f.simbolo] || {})})).filter(f => f.precio);
  return datos;
}

// ---------------------------------------------------------------- dibujo
const fmtNum = (v, dec = 2) => v.toLocaleString('es-AR', {minimumFractionDigits: dec, maximumFractionDigits: dec});
const fmtPrecio = p => p >= 100 ? fmtNum(p, 2) : p >= 1 ? fmtNum(p, 4) : p.toPrecision(4).replace('.', ',');
const fmtSig = (v, dec = 2) => isNaN(v) ? '—' : (v >= 0 ? '+' : '') + fmtNum(v, dec);
const fmtVol = v => v >= 1e9 ? '$' + fmtNum(v / 1e9, 2) + ' mil M' : v >= 1e6 ? '$' + fmtNum(v / 1e6, 1) + ' M' : v >= 1e3 ? '$' + Math.round(v / 1e3) + ' mil' : '$' + Math.round(v);

function colorDe(valor, escala) {
  if (valor == null || isNaN(valor)) return 'rgba(64,64,64,.9)';
  const a = 0.22 + 0.68 * Math.min(1, Math.abs(valor) / escala);
  return valor >= 0 ? `rgba(22,163,74,${a.toFixed(2)})` : `rgba(220,38,38,${a.toFixed(2)})`;
}
function destacado(f, media) {
  const r = [];
  if (f.puntaje >= 30) r.push('presión compradora');
  if (f.puntaje <= -30) r.push('presión vendedora');
  if (f.volx >= 2) r.push('volumen ' + fmtNum(f.volx, 1) + '× lo normal');
  if (Math.abs(f.var - media) >= 5) r.push('se movió ' + fmtSig(f.var, 1) + ' % (mercado ' + fmtSig(media, 1) + ' %)');
  return r.join(' · ');
}
function tarjetas(lista, media) {
  return lista.map(f => {
    const valor = cfg.color === 'puntaje' ? f.puntaje : f.var, escala = cfg.color === 'puntaje' ? 60 : 8;
    const razon = destacado(f, media);
    return `<div class="tarjeta" style="background:${colorDe(valor, escala)}" title="${esc(razon || 'sin señales fuertes')}">
      <div class="fila"><span class="sim">${razon ? '🔥 ' : ''}${esc(f.activo)}</span><span class="var">${fmtSig(f.var)}%</span></div>
      <div class="precio">${fmtPrecio(f.precio)}</div>
      <div class="fila chico"><span>Vol. 24 h ${fmtVol(f.vol24)}</span><span>Presión ${fmtSig(f.puntaje, 0)}</span></div>
      <div class="fila chico"><span>15 min ${fmtSig(f.mom15)}%</span><span>Compra ${isNaN(f.compra) ? '—' : Math.round(f.compra) + '%'}</span></div>
      <div class="barra"><div style="width:${Math.min(100, Math.abs(f.puntaje))}%"></div></div></div>`;
  }).join('');
}

function ordenados() {
  const k = {puntaje: 'puntaje', var: 'var', vol24: 'vol24', volx: 'volx'}[cfg.orden];
  return [...datos].sort((a, b) => (isNaN(b[k]) ? -1e18 : b[k]) - (isNaN(a[k]) ? -1e18 : a[k]));
}

function dibujarTarjetas() {
  if (!datos.length) return;
  const df = ordenados(), media = suma(datos.map(f => f.var)) / datos.length;
  const compran = datos.filter(f => f.puntaje > 0).length, lider = [...datos].sort((a, b) => b.puntaje - a.puntaje)[0];
  $('kpis').innerHTML = `
    <div class="kpi"><span>Activos</span><b>${datos.length}</b></div>
    <div class="kpi"><span>Con presión compradora</span><b>${compran}</b><small>${datos.length - compran} vendiendo</small></div>
    <div class="kpi"><span>Variación promedio 24 h</span><b class="${media >= 0 ? 'up' : 'down'}">${fmtSig(media)} %</b></div>
    <div class="kpi"><span>Más comprado ahora</span><b>${esc(lider.activo)}</b><small class="up">${fmtSig(lider.puntaje, 0)} presión</small></div>`;
  const dest = df.filter(f => destacado(f, media)).slice(0, 8);
  $('destacados').innerHTML = dest.length ? tarjetas(dest, media)
    : '<p class="nota">Ningún activo con señales fuertes ahora (presión ±30, volumen 2× o 5 puntos distinto del mercado).</p>';
  $('todas').innerHTML = tarjetas(df, media);
  $('masComprados').innerHTML = tarjetas([...datos].sort((a, b) => b.puntaje - a.puntaje).slice(0, 6), media);

  $('tabla').innerHTML = '<table><thead><tr><th>Activo</th><th>Precio</th><th>24 h %</th><th>Presión</th><th>% compra</th><th>Vol. ×</th><th>15 min %</th><th>Vol. 24 h</th></tr></thead><tbody>' +
    df.map(f => {
      const w = Math.min(50, Math.abs(f.puntaje) / 2), lado = f.puntaje >= 0 ? `left:50%;width:${w}%;background:#22c55e` : `right:50%;width:${w}%;background:#ef4444`;
      return `<tr><td>${esc(f.activo)}</td><td>${fmtPrecio(f.precio)}</td><td class="${f.var >= 0 ? 'up' : 'down'}">${fmtSig(f.var)}</td>
        <td><span class="pbar"><i style="${lado}"></i></span>${fmtSig(f.puntaje, 0)}</td><td>${isNaN(f.compra) ? '—' : Math.round(f.compra)}</td>
        <td>${isNaN(f.volx) ? '—' : fmtNum(f.volx, 1)}</td><td>${fmtSig(f.mom15)}</td><td>${fmtVol(f.vol24)}</td></tr>`;
    }).join('') + '</tbody></table>';

  if (window.Plotly && cfg.solapa === 'tarjetas') {
    Plotly.react('mapa', [{
      type: 'treemap', labels: datos.map(f => f.activo), parents: datos.map(() => ''), values: datos.map(f => f.vol24),
      customdata: datos.map(f => [fmtPrecio(f.precio), fmtSig(f.var), fmtSig(f.puntaje, 0)]),
      texttemplate: '<b>%{label}</b><br>%{customdata[1]}%', textfont: {size: 15, color: '#fff'},
      hovertemplate: '<b>%{label}</b><br>Precio %{customdata[0]}<br>24 h %{customdata[1]}%<br>Presión %{customdata[2]}<extra></extra>',
      marker: {colors: datos.map(f => f.var), colorscale: [[0, '#b91c1c'], [0.5, '#3f3f46'], [1, '#15803d']], cmin: -8, cmax: 8,
               showscale: true, colorbar: {title: {text: '24 h %', font: {color: '#9ca3af'}}, tickfont: {color: '#9ca3af'}},
               line: {color: '#0e1117', width: 2}},
    }], {margin: {t: 0, l: 0, r: 0, b: 0}, paper_bgcolor: 'rgba(0,0,0,0)', font: {color: '#e5e7eb'}}, {displayModeBar: false, responsive: true});
  }
}

// ---------------------------------------------------------------- monitor y flujo (plantillas con los libros en vivo)
const plantillas = {};
async function plantilla(nombre) { return plantillas[nombre] ||= await (await fetch(nombre)).text(); }

function etiqueta(v, compra) {
  if (v >= 0) return compra >= 50 ? 'Acumulación' : 'Toma de ganancias';
  return compra >= 50 ? 'Compras en la baja' : 'Distribución';
}
let monitorHora = 0, monitorFilas = 0;
async function armarMonitor(forzar = false) {
  if (cfg.solapa !== 'monitor' || !datos.length) return;
  if (!forzar && Date.now() - monitorHora < 3 * 60 * 1000 && monitorFilas === cfg.filas) return;
  monitorHora = Date.now(); monitorFilas = cfg.filas;
  const val = datos.filter(f => !isNaN(f.puntaje)).sort((a, b) => b.puntaje - a.puntaje), mitad = cfg.filas >> 1;
  const sel = [...val.slice(0, mitad), ...val.slice(-(cfg.filas - mitad))].filter((f, i, a) => a.findIndex(g => g.activo === f.activo) === i)
    .sort((a, b) => b.puntaje - a.puntaje);
  const filas = (await enParalelo(sel, async f => {
    const v = await velas(f.simbolo, '15m', 96), ult = v.slice(-32), cuatro = v.slice(-4);
    const compra = isNaN(f.compra) ? 50 : f.compra;
    return {simbolo: f.simbolo, base: f.activo, nombre: f.activo + '/USDT', puntaje: f.puntaje, var: f.var, precio: f.precio, compra,
            soporte: Math.min(...ult.map(x => x.minimo)), resistencia: Math.max(...ult.map(x => x.maximo)),
            zona: [Math.min(...cuatro.map(x => x.minimo)), Math.max(...cuatro.map(x => x.maximo))],
            etiqueta: etiqueta(f.var, compra), cierres: v.slice(-64).map(x => x.cierre),
            minimo: Math.min(50000, Math.max(2000, f.vol24 / 20000))};
  })).filter(Boolean);
  const html = (await plantilla('monitor.html')).replace('__CONFIG__', JSON.stringify({filas}));
  const marco = $('monitorMarco');
  marco.innerHTML = '';
  const fr = document.createElement('iframe');
  fr.style.height = (130 + 196 * filas.length) + 'px'; fr.srcdoc = html; fr.title = 'Monitor de libros en vivo';
  marco.appendChild(fr);
}

window.addEventListener('message', e => {
  const fr = $('monitorMarco').querySelector('iframe');
  if (fr && e.source === fr.contentWindow && e.data && e.data.altoMonitor > 50) fr.style.height = e.data.altoMonitor + 'px';
});

let flujoPar = '';
async function armarFlujo(forzar = false) {
  if (cfg.solapa !== 'flujo' || !pares.length) return;
  const par = pares.includes(cfg.par) ? cfg.par : pares[0];
  if (!forzar && par === flujoPar) return;
  flujoPar = par;
  const alto = 640;
  const conf = {simbolo: par, lista: pares.slice(0, 15), alto, minimo: (par === 'BTCUSDT' || par === 'ETHUSDT') ? 50000 : 5000};
  const fr = document.createElement('iframe');
  fr.style.height = (alto + 12) + 'px'; fr.title = 'Flujo de operaciones en vivo';
  fr.srcdoc = (await plantilla('flujo.html')).replace('__CONFIG__', JSON.stringify(conf));
  $('flujoMarco').innerHTML = ''; $('flujoMarco').appendChild(fr);
}

function llenarPares() {
  const s = $('cPar'), actual = pares.includes(cfg.par) ? cfg.par : (pares.includes('BTCUSDT') ? 'BTCUSDT' : pares[0]);
  s.innerHTML = pares.map(p => `<option value="${p}"${p === actual ? ' selected' : ''}>${p.replace('USDT', ' / USDT')}</option>`).join('');
  cfg.par = actual;
}

// apaga los libros en vivo de la solapa que no se ve (ahorra batería y conexiones)
function mostrarSolapa(nombre) {
  cfg.solapa = nombre; guardar('solapa', nombre);
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('activa', b.dataset.solapa === nombre));
  document.querySelectorAll('.solapa').forEach(s => s.classList.toggle('activa', s.id === 's-' + nombre));
  if (nombre !== 'monitor') { $('monitorMarco').innerHTML = '<div class="cargando">Cargando el monitor…</div>'; monitorHora = 0; }
  if (nombre !== 'flujo') { $('flujoMarco').innerHTML = ''; flujoPar = ''; }
  if (nombre === 'monitor') armarMonitor(true);
  if (nombre === 'flujo') armarFlujo(true);
  if (nombre === 'robots' && window.abrirRobots) window.abrirRobots();
  if (nombre === 'tarjetas') { dibujarTarjetas(); setTimeout(() => window.Plotly && Plotly.Plots.resize('mapa'), 50); }
}

// ---------------------------------------------------------------- bucle
let temporizador = null, ocupado = false;
async function vuelta() {
  if (ocupado) return;
  ocupado = true;
  try {
    await escanear();
    dibujarTarjetas();
    await armarMonitor();
    await armarFlujo();
    $('estado').innerHTML = '<b>●</b> actualizado ' + new Date().toLocaleTimeString('es-AR') + ' · cada ' + cfg.ref + ' s';
  } catch (e) {
    $('estado').textContent = 'no pude leer los datos (' + e.message + '), reintento…';
  } finally {
    ocupado = false;
  }
}
function programar() { clearInterval(temporizador); temporizador = setInterval(() => { if (!document.hidden) vuelta(); }, cfg.ref * 1000); }

for (const [id, k] of [['cN', 'n'], ['cOrden', 'orden'], ['cColor', 'color'], ['cFilas', 'filas'], ['cRef', 'ref']]) {
  const el = $(id); el.value = String(cfg[k]);
  el.addEventListener('change', () => {
    cfg[k] = /^(n|filas|ref)$/.test(k) ? +el.value : el.value; guardar(k, el.value);
    if (k === 'ref') programar();
    if (k === 'orden' || k === 'color') dibujarTarjetas();
    if (k === 'filas') armarMonitor(true);
    if (k === 'n') vuelta().then(() => armarMonitor(true));
  });
}
$('cPar').addEventListener('change', e => { cfg.par = e.target.value; guardar('par', cfg.par); armarFlujo(true); });
document.querySelectorAll('nav button').forEach(b => b.addEventListener('click', () => mostrarSolapa(b.dataset.solapa)));

mostrarSolapa(cfg.solapa);
vuelta();
programar();
