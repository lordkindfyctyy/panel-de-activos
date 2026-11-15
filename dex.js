// Solapa "HelloDex": DEX de práctica dentro del panel. Misma matemática que los contratos de HelloDex (Pool.sol): pools de
// producto constante x·y=k con comisión de 0,3 %. Las fichas (eUSDT, eBTC...) son de práctica y no valen nada.
// - Cada visitante tiene su billetera (1.000 eUSDT) y sus pools guardados en su navegador.
// - Antes de cada cambio un "arbitrajista" lleva el pool al precio real de Binance, como pasa en un DEX de verdad.
// - Abajo se ven las operaciones que los robots ejecutan cada hora en su HelloDex simulado (con la clave de la solapa Robots).
(() => {
  const D = id => document.getElementById(id);
  const LIQ = 2_000_000, FEE = 30, BPS = 10_000, CAPITAL = 1000, TOLERANCIA = 0.005;
  const escD = t => String(t ?? '').replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
  const n2 = (v, d = 2) => (+v).toLocaleString('es-AR', {minimumFractionDigits: d, maximumFractionDigits: d});
  const fichas = v => (+v).toLocaleString('es-AR', {maximumSignificantDigits: 6});
  const pc = (v, d = 2) => (v >= 0 ? '+' : '') + n2(v, d) + '%';
  const sale = (entra, resEntra, resSale) => { const con = entra * (BPS - FEE); return con * resSale / (resEntra * BPS + con); };
  let precios = {}, est = null;

  // ------------------------------------------------------------ billetera y pools del visitante (en su navegador)
  function cargar() {
    try { est = JSON.parse(localStorage.getItem('panel.dex')); } catch (e) { est = null; }
    if (!est || !est.billetera) est = {billetera: {USDT: CAPITAL}, pools: {}, historial: [], n: 0};
  }
  function guardar() { try { localStorage.setItem('panel.dex', JSON.stringify(est)); } catch (e) {} }

  async function actualizarPrecios(monedas) {
    const syms = monedas.filter(m => m !== 'USDT').map(m => m + 'USDT');
    if (!syms.length) return;
    try {
      const r = await fetch('https://data-api.binance.vision/api/v3/ticker/price?symbols=' + encodeURIComponent(JSON.stringify(syms)));
      for (const t of await r.json()) precios[t.symbol.replace(/USDT$/, '')] = +t.price;
    } catch (e) {}
  }
  function pool(m) {
    if (!est.pools[m]) est.pools[m] = {moneda: LIQ / precios[m], usdt: LIQ, swaps: 0};
    return est.pools[m];
  }
  function alPrecio(m) {  // el arbitrajista lleva el pool al precio real
    const p = pool(m), real = precios[m], actual = p.usdt / p.moneda;
    if (!real || Math.abs(actual / real - 1) < 0.0005) return;
    const k = p.moneda * p.usdt;
    if (actual < real) { const dy = (Math.sqrt(k * real) - p.usdt) / (1 - FEE / BPS); const out = sale(dy, p.usdt, p.moneda); p.usdt += dy; p.moneda -= out; }
    else { const dx = (Math.sqrt(k / real) - p.moneda) / (1 - FEE / BPS); const out = sale(dx, p.moneda, p.usdt); p.moneda += dx; p.usdt -= out; }
  }
  // cotización: de `de` a `a` (una de las dos es USDT o se pasa por USDT, como el router con dos pools)
  function cotizar(de, a, cant) {
    let x = cant, ruta = [];
    const paso = (m, deUsdt, entra) => { const p = pool(m); return deUsdt ? sale(entra, p.usdt, p.moneda) : sale(entra, p.moneda, p.usdt); };
    if (de !== 'USDT') { x = paso(de, false, x); ruta.push(de + '→USDT'); }
    if (a !== 'USDT') { x = paso(a, true, x); ruta.push('USDT→' + a); }
    const valorEntra = de === 'USDT' ? cant : cant * precios[de], valorSale = a === 'USDT' ? x : x * precios[a];
    return {sale: x, ruta, impacto: valorEntra ? (valorSale / valorEntra - 1) * 100 : 0};
  }
  function ejecutar(de, a, cant) {
    const aplicar = (m, deUsdt, entra) => {
      const p = pool(m), out = deUsdt ? sale(entra, p.usdt, p.moneda) : sale(entra, p.moneda, p.usdt);
      if (deUsdt) { p.usdt += entra; p.moneda -= out; } else { p.moneda += entra; p.usdt -= out; }
      p.swaps++; return out;
    };
    let x = cant;
    if (de !== 'USDT') x = aplicar(de, false, x);
    if (a !== 'USDT') x = aplicar(a, true, x);
    est.billetera[de] = (est.billetera[de] || 0) - cant;
    est.billetera[a] = (est.billetera[a] || 0) + x;
    return x;
  }
  async function comprobante(texto) {
    const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(texto));
    return '0x' + [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('');
  }

  // ------------------------------------------------------------ interfaz
  function monedasDisponibles() {
    const base = (typeof pares !== 'undefined' && pares.length ? pares : ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT'])
      .slice(0, 20).map(p => p.replace(/USDT$/, ''));
    return ['USDT', ...new Set([...base, ...Object.keys(est.billetera).filter(m => m !== 'USDT' && est.billetera[m] > 0)])];
  }
  function llenarSelects() {
    const ms = monedasDisponibles();
    for (const [id, def] of [['dDe', 'USDT'], ['dA', 'BTC']]) {
      const s = D(id), actual = s.value || def;
      s.innerHTML = ms.map(m => `<option value="${escD(m)}">e${escD(m)}</option>`).join('');
      s.value = ms.includes(actual) ? actual : def;
    }
  }
  async function refrescarCotizacion() {
    const de = D('dDe').value, a = D('dA').value, cant = parseFloat(String(D('dCant').value).replace(',', '.'));
    D('dSaldo').textContent = 'Tenés ' + fichas(est.billetera[de] || 0) + ' e' + de;
    if (de === a) { D('dCot').innerHTML = '<span class="down">Elegí dos fichas distintas.</span>'; D('dBoton').disabled = true; return; }
    await actualizarPrecios([de, a]);
    if (!(cant > 0)) { D('dCot').innerHTML = '<span class="nota">Escribí cuánto querés cambiar.</span>'; D('dBoton').disabled = true; return; }
    [de, a].filter(m => m !== 'USDT').forEach(alPrecio);
    const q = cotizar(de, a, cant);
    const falta = cant > (est.billetera[de] || 0) + 1e-12;
    D('dCot').innerHTML = `Recibís <b>${fichas(q.sale)} e${escD(a)}</b> · precio ${fichas(de === 'USDT' ? cant / q.sale : q.sale / cant)} ${de === 'USDT' ? 'eUSDT por e' + escD(a) : 'e' + escD(a) + ' por e' + escD(de)}
      <br><span class="nota">Comisión 0,3 % por pool · impacto + comisión ${pc(q.impacto, 3)} · mínimo con 0,5 % de tolerancia: ${fichas(q.sale * (1 - TOLERANCIA))} · ruta ${escD(q.ruta.join(' · '))}</span>
      ${falta ? '<br><span class="down">No te alcanzan las fichas.</span>' : ''}`;
    D('dBoton').disabled = falta;
  }
  async function cambiar() {
    const de = D('dDe').value, a = D('dA').value, cant = parseFloat(String(D('dCant').value).replace(',', '.'));
    if (!(cant > 0) || de === a || cant > (est.billetera[de] || 0) + 1e-12) return;
    await actualizarPrecios([de, a]);
    [de, a].filter(m => m !== 'USDT').forEach(alPrecio);
    const recibe = ejecutar(de, a, cant);
    est.n++;
    const op = {n: est.n, t: new Date().toISOString(), de, a, entrega: cant, recibe, precio: de === 'USDT' ? cant / recibe : recibe / cant};
    op.comprobante = await comprobante(JSON.stringify(op));
    est.historial.unshift(op); est.historial = est.historial.slice(0, 200);
    guardar(); llenarSelects(); dibujarBilletera(); refrescarCotizacion();
  }
  async function dibujarBilletera() {
    const ms = Object.keys(est.billetera).filter(m => est.billetera[m] > 1e-12);
    await actualizarPrecios(ms);
    let total = 0;
    const filas = ms.map(m => { const v = m === 'USDT' ? est.billetera[m] : est.billetera[m] * (precios[m] || 0); total += v; return {m, f: est.billetera[m], v}; })
      .sort((a, b) => b.v - a.v);
    D('dBilletera').innerHTML = `<div class="dex-total">${n2(total)} <small>eUSDT</small> <span class="${total >= CAPITAL ? 'up' : 'down'}">${pc((total / CAPITAL - 1) * 100)}</span></div>
      <table><tbody>${filas.map(x => `<tr><td>e${escD(x.m)}</td><td>${fichas(x.f)}</td><td>${n2(x.v)} eUSDT</td></tr>`).join('')}</tbody></table>`;
    D('dHistorial').innerHTML = est.historial.length ? '<table><thead><tr><th>#</th><th>Cuándo</th><th>Entregó</th><th>Recibió</th><th>Comprobante</th></tr></thead><tbody>' +
      est.historial.slice(0, 30).map(o => `<tr><td>${o.n}</td><td>${escD(new Date(o.t).toLocaleString('es-AR', {day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'}))}</td>
        <td>${fichas(o.entrega)} e${escD(o.de)}</td><td>${fichas(o.recibe)} e${escD(o.a)}</td><td title="${escD(o.comprobante)}"><code>${escD(o.comprobante.slice(0, 10))}…</code></td></tr>`).join('') + '</tbody></table>'
      : '<p class="nota">Todavía no hiciste ningún cambio.</p>';
  }

  // ------------------------------------------------------------ los robots en HelloDex (datos cifrados de la solapa Robots)
  function dibujarRobots() {
    const d = window.datosRobots && window.datosRobots.dex;
    if (!d) { D('dRobots').innerHTML = '<p class="nota">Para ver las operaciones de los robots en HelloDex, abrí la solapa <b>🤖 Robots</b> y poné la clave; después volvé acá.</p>'; return; }
    const tot = d.bots.reduce((a, b) => a + b.valor, 0);
    D('dRobots').innerHTML = `
      <p class="nota">${d.total} operaciones ejecutadas en HelloDex simulado (se suman cada hora). Cada robot arrancó con 1.000 eUSDT; el valor está a precio de mercado.</p>
      <div class="kpis">${d.bots.map(b => `<div class="kpi" style="border-left:4px solid ${({'Bot 1': '#60a5fa', 'Bot 2': '#f59e0b', 'Bot 3': '#a78bfa', 'Bot 4': '#34d399', 'Bot 5': '#f472b6', 'Bot 6': '#22d3ee', 'Bot 7': '#facc15', 'Bot 8': '#fb7185', 'Bot 9': '#4ade80', 'Bot 10': '#c084fc', 'Bot 11': '#f97316', 'Bot 12': '#38bdf8', 'Bot 13': '#a3e635', 'Bot 14': '#e879f9', 'Bot 15': '#fbbf24'})[b.bot] || '#fff'}">
        <span>${escD(b.bot)} en HelloDex</span><b>${n2(b.valor)} <small>eUSDT</small></b><small class="${b.resultado_pct >= 0 ? 'up' : 'down'}">${pc(b.resultado_pct)}${b.ajustes ? ' · ajustes ' + n2(b.ajustes) : ''}</small>
        <br><small>${b.posiciones.length ? b.posiciones.map(p => escD(p.moneda) + (p.fichas < 0 ? ' (corto)' : '')).join(', ') : 'todo en eUSDT'}</small></div>`).join('')}</div>
      <div class="tabla"><table><thead><tr><th>#</th><th>Robot</th><th>Cuándo</th><th>Operación</th><th>Entregó</th><th>Recibió</th><th>Precio robot → HelloDex</th><th>Deslizamiento</th><th>Movió el pool</th><th>Comprobante</th></tr></thead><tbody>
      ${d.operaciones.slice(0, 120).map(o => `<tr><td>${o.numero || ''}</td><td>${escD(o.bot)}</td><td>${escD(String(o.fecha).slice(5, 16).replace('T', ' '))}</td>
        <td class="${/corto|venta/.test(o.lado) ? 'down' : 'up'}">${escD(o.lado)} ${escD(o.moneda)}</td><td>${escD(o.entrega || '')}</td><td>${escD(o.recibe || o.nota || '')}</td>
        <td>${fichas(o.precio_robot)} → ${o.precio_ejecutado ? fichas(o.precio_ejecutado) : '—'}</td><td>${o.deslizamiento_pct != null ? pc(o.deslizamiento_pct, 3) : '—'}</td>
        <td>${o.impacto_pool_pct != null ? pc(o.impacto_pool_pct, 3) : '—'}</td><td title="${escD(o.comprobante || '')}"><code>${escD((o.comprobante || '').slice(0, 10))}…</code></td></tr>`).join('')}
      </tbody></table></div>
      <h3 class="sub3">Pools de HelloDex simulado</h3>
      <div class="tabla"><table><thead><tr><th>Pool</th><th>Precio</th><th>Liquidez</th><th>Swaps</th><th>Volumen</th></tr></thead><tbody>
      ${d.pools.map(p => `<tr><td>e${escD(p.moneda)} / eUSDT</td><td>${fichas(p.precio)}</td><td>${n2(p.liquidez_usdt / 1e6, 2)} M</td><td>${p.swaps}</td><td>${n2(p.volumen_usdt, 0)}</td></tr>`).join('')}
      </tbody></table></div>`;
  }

  cargar();
  D('dDe').addEventListener('change', refrescarCotizacion);
  D('dA').addEventListener('change', refrescarCotizacion);
  D('dCant').addEventListener('input', refrescarCotizacion);
  D('dInvertir').addEventListener('click', () => { const de = D('dDe').value; D('dDe').value = D('dA').value; D('dA').value = de; refrescarCotizacion(); });
  D('dMax').addEventListener('click', () => { D('dCant').value = String(+(est.billetera[D('dDe').value] || 0).toPrecision(8)); refrescarCotizacion(); });
  D('dBoton').addEventListener('click', cambiar);
  D('dReiniciar').addEventListener('click', () => { est = {billetera: {USDT: CAPITAL}, pools: {}, historial: [], n: 0}; guardar(); llenarSelects(); dibujarBilletera(); refrescarCotizacion(); });
  D('dIrRobots').addEventListener('click', () => document.querySelector('nav button[data-solapa="robots"]').click());
  window.addEventListener('robots-datos', dibujarRobots);
  window.abrirDex = () => { llenarSelects(); dibujarBilletera(); refrescarCotizacion(); dibujarRobots(); };
  if (D('s-dex').classList.contains('activa')) window.abrirDex();
})();
