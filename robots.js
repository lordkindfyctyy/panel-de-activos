// Solapa "Robots": resultados de los robots de PRÁCTICA (sin plata), cifrados con una clave.
// Los datos (robots/datos.json) los publica cada hora GitHub Actions desde el repo privado de los robots.
(() => {
  const R = id => document.getElementById(id);
  const COLORES = {'Bot 1': '#60a5fa', 'Bot 2': '#f59e0b', 'Bot 3': '#a78bfa', 'Bot 4': '#34d399', 'Bot 5': '#f472b6', 'Bot 6': '#22d3ee', 'Bot 7': '#facc15', 'Bot 8': '#fb7185', 'Bot 9': '#4ade80', 'Bot 10': '#c084fc', 'Bot 11': '#f97316', 'Bot 12': '#38bdf8', 'Bot 13': '#a3e635', 'Bot 14': '#e879f9', 'Bot 15': '#fbbf24', 'BTC': '#9ca3af'};
  const escR = t => String(t).replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
  const num = (v, d = 2) => (+v).toLocaleString('es-AR', {minimumFractionDigits: d, maximumFractionDigits: d});
  const sig = (v, d = 1) => isNaN(v) ? '—' : (v >= 0 ? '+' : '') + num(v, d);
  let datos = null, periodo = 'mes';

  const b64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  async function descifrar(archivo, clave) {
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(clave), 'PBKDF2', false, ['deriveKey']);
    const llave = await crypto.subtle.deriveKey({name: 'PBKDF2', salt: b64(archivo.sal), iterations: archivo.iter, hash: 'SHA-256'},
      base, {name: 'AES-GCM', length: 256}, false, ['decrypt']);
    const plano = await crypto.subtle.decrypt({name: 'AES-GCM', iv: b64(archivo.nonce)}, llave, b64(archivo.datos));
    return JSON.parse(new TextDecoder().decode(plano));
  }
  function csv(texto) {
    const l = (texto || '').trim().split(/\r?\n/).filter(Boolean);
    if (l.length < 2) return [];
    const cab = l[0].split(',');
    return l.slice(1).map(f => { const c = f.split(','); return Object.fromEntries(cab.map((k, i) => [k, c[i]])); });
  }
  const leerClave = () => { try { return localStorage.getItem('panel.claveRobots') || sessionStorage.getItem('panel.claveRobots'); } catch (e) { return null; } };
  const guardarClave = (c, recordar) => { try { (recordar ? localStorage : sessionStorage).setItem('panel.claveRobots', c); } catch (e) {} };
  const olvidarClave = () => { try { localStorage.removeItem('panel.claveRobots'); sessionStorage.removeItem('panel.claveRobots'); } catch (e) {} };

  async function bajar() {
    const r = await fetch('robots/datos.json?t=' + Date.now(), {cache: 'no-store'});
    if (!r.ok) throw new Error(r.status === 404 ? 'todavía no hay datos publicados' : 'HTTP ' + r.status);
    return r.json();
  }

  async function abrir(clave, recordar) {
    R('rbError').textContent = '';
    try {
      const archivo = await bajar();
      datos = await descifrar(archivo, clave);
      window.datosRobots = datos; window.dispatchEvent(new Event('robots-datos'));
      guardarClave(clave, recordar);
      R('rbCandado').style.display = 'none'; R('rbContenido').style.display = 'block';
      dibujar();
    } catch (e) {
      datos = null;
      R('rbError').textContent = e.name === 'OperationError' ? 'Clave incorrecta.' : 'No pude abrir los datos: ' + e.message;
      olvidarClave();
    }
  }

  function hace(iso) {
    const min = Math.round((Date.now() - new Date(iso)) / 60000);
    return min < 60 ? 'hace ' + min + ' min' : min < 1440 ? 'hace ' + Math.round(min / 60) + ' h' : 'hace ' + Math.round(min / 1440) + ' días';
  }

  function lineas(div, series, titulo) {
    if (!window.Plotly) return;
    Plotly.react(div, series.map(s => ({x: s.x, y: s.y, name: s.nombre, type: 'scatter', mode: s.x.length < 3 ? 'lines+markers' : 'lines',
      line: {color: COLORES[s.nombre] || '#fff', width: s.nombre === 'BTC' ? 1.5 : 2.2, dash: s.nombre === 'BTC' ? 'dot' : 'solid'},
      hovertemplate: '%{x}<br>' + s.nombre + ': %{y:,.2f} USDT<extra></extra>'})),
      {margin: {t: 10, l: 50, r: 10, b: 30}, paper_bgcolor: 'rgba(0,0,0,0)', plot_bgcolor: 'rgba(0,0,0,0)', font: {color: '#e5e7eb'},
       xaxis: {gridcolor: '#262c38'}, yaxis: {gridcolor: '#262c38', title: {text: titulo}}, legend: {orientation: 'h', y: -0.15},
       hovermode: 'x unified'}, {displayModeBar: false, responsive: true});
  }

  // rendimiento por período (día/semana/mes/año) a partir del valor diario simulado
  function porPeriodo(filas, columnas) {
    const clave = f => {
      const d = new Date(f.fecha + 'T00:00:00Z');
      if (periodo === 'dia') return f.fecha;
      if (periodo === 'mes') return f.fecha.slice(0, 7);
      if (periodo === 'anio') return f.fecha.slice(0, 4);
      const lunes = new Date(d); lunes.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
      return 'sem. ' + lunes.toISOString().slice(0, 10);
    };
    const grupos = new Map();
    let anterior = null;
    for (const f of filas) {
      const k = clave(f);
      if (!grupos.has(k)) grupos.set(k, {inicio: anterior || f, fin: f});
      grupos.get(k).fin = f; anterior = f;
    }
    return [...grupos.entries()].map(([k, g]) => ({periodo: k, ...Object.fromEntries(columnas.map(c => [c, (g.fin[c] / g.inicio[c] - 1) * 100]))}));
  }

  function dibujar() {
    if (!datos) return;
    R('rbActualizado').textContent = 'Actualizado ' + hace(datos.actualizado) + ' (' + new Date(datos.actualizado).toLocaleString('es-AR') + ')';
    // tarjetas de cada bot
    R('rbBots').innerHTML = datos.bots.map(b => {
      const p = (b.valor / b.capital - 1) * 100;
      return `<div class="kpi" style="border-left:4px solid ${COLORES[b.id]}"><span>${escR(b.id)} · ${escR(b.nombre.replace(/^Robot \d+ /, ''))}</span>
        <b>${num(b.valor)} <small>USDT</small></b><small class="${p >= 0 ? 'up' : 'down'}">${sig(p, 2)} % desde ${escR(b.inicio.slice(0, 10))}</small>
        <br><small>${escR(b.mercado)}</small></div>`;
    }).join('');

    // en vivo
    const vivo = csv(datos.vivo), bots = [...new Set(vivo.map(f => f.bot))];
    const series = bots.map(b => ({nombre: b, x: vivo.filter(f => f.bot === b).map(f => f.fecha), y: vivo.filter(f => f.bot === b).map(f => +f.valor)}));
    const b1 = vivo.filter(f => f.bot === bots[0]);
    series.push({nombre: 'BTC', x: b1.map(f => f.fecha), y: b1.map(f => +f.btc)});
    lineas('rbVivo', series, 'USDT');

    // simulación con filtros
    const sim = csv(datos.sim_diaria).map(f => Object.fromEntries(Object.entries(f).map(([k, v]) => [k, k === 'fecha' ? v : +v])));
    const cols = Object.keys(sim[0] || {}).filter(k => k !== 'fecha');
    lineas('rbSim', cols.map(c => ({nombre: c, x: sim.map(f => f.fecha), y: sim.map(f => f[c])})), 'USDT (empezando con 1.000)');
    const per = porPeriodo(sim, cols).reverse();
    const botsCols = cols.filter(c => c !== 'BTC'), ganados = Object.fromEntries(botsCols.map(c => [c, 0]));
    for (const f of per) { const g = botsCols.reduce((a, c) => f[c] > f[a] ? c : a, botsCols[0]); ganados[g]++; f._gana = g; }
    const total = per.length || 1;
    R('rbGanador').innerHTML = 'Quién ganó más ' + {dia: 'días', semana: 'semanas', mes: 'meses', anio: 'años'}[periodo] + ': ' +
      botsCols.sort((a, b) => ganados[b] - ganados[a]).map(c => `<span class="chipR" style="border-color:${COLORES[c]}">${c} <b>${ganados[c]}</b> <small>(${Math.round(100 * ganados[c] / total)} %)</small></span>`).join(' ');
    R('rbTablaSim').innerHTML = '<table><thead><tr><th>' + {dia: 'Día', semana: 'Semana', mes: 'Mes', anio: 'Año'}[periodo] + '</th>' +
      cols.map(c => `<th>${c}</th>`).join('') + '</tr></thead><tbody>' + per.slice(0, periodo === 'dia' ? 120 : 400).map(f =>
        '<tr><td>' + escR(f.periodo) + '</td>' + cols.map(c => `<td class="${f[c] >= 0 ? 'up' : 'down'}"${f._gana === c ? ' style="font-weight:800;background:rgba(255,255,255,.06)"' : ''}>${sig(f[c])}</td>`).join('') + '</tr>').join('') + '</tbody></table>';

    // posiciones y operaciones
    const pos = csv(datos.posiciones);
    R('rbPos').innerHTML = '<table><thead><tr><th>Bot</th><th>Moneda</th><th>Lado</th><th>Valor USDT</th></tr></thead><tbody>' +
      pos.map(f => `<tr><td>${escR(f.bot)}</td><td>${escR(f.moneda)}</td><td class="${f.lado === 'en corto' ? 'down' : f.lado === 'comprado' ? 'up' : ''}">${escR(f.lado)}</td><td>${num(f.valor_usdt)}</td></tr>`).join('') + '</tbody></table>';
    const ops = csv(datos.operaciones);
    R('rbOps').innerHTML = ops.length ? '<table><thead><tr><th>Bot</th><th>Fecha</th><th>Moneda</th><th>Operación</th><th>Precio</th><th>USDT</th></tr></thead><tbody>' +
      ops.slice(0, 100).map(f => `<tr><td>${escR(f.bot)}</td><td>${escR(f.fecha.replace('T', ' ').slice(0, 16))}</td><td>${escR(f.moneda)}</td><td class="${/corto|venta/.test(f.lado) ? 'down' : 'up'}">${escR(f.lado)}</td><td>${(+f.precio).toPrecision(6)}</td><td>${num(f.usdt)}</td></tr>`).join('') + '</tbody></table>'
      : '<p class="nota">Todavía sin operaciones.</p>';

    // aciertos, abiertas, bitácora y memoria
    const ac = datos.aciertos || [], nn = v => v == null ? '—' : v;
    R('rbAciertos').innerHTML = ac.length ? '<table><thead><tr><th>Robot</th><th>Cerradas</th><th>Ganadoras</th><th>Ganancia media</th><th>Pérdida media</th><th>Factor</th><th>Resultado</th><th>Mejor / peor</th><th>Abiertas</th></tr></thead><tbody>' +
      ac.map(a => {
        const ab = (datos.abiertas || []).filter(x => x.bot === a.bot), gan = ab.filter(x => x.va_pct > 0).length;
        return `<tr><td style="border-left:3px solid ${COLORES[a.bot] || '#fff'}">${escR(a.bot)}</td><td>${a.cerradas}</td>
          <td>${a.ganadoras_pct == null ? '—' : num(a.ganadoras_pct, 0) + ' %'}</td><td class="up">${a.ganancia_media_pct == null ? '—' : sig(a.ganancia_media_pct, 2) + ' %'}</td>
          <td class="down">${a.perdida_media_pct == null ? '—' : sig(a.perdida_media_pct, 2) + ' %'}</td><td title="ganancias ÷ pérdidas (más de 1 = gana más de lo que pierde)">${nn(a.factor)}</td>
          <td class="${a.resultado_usdt >= 0 ? 'up' : 'down'}">${sig(a.resultado_usdt, 2)} USDT</td>
          <td>${a.mejor_pct == null ? '—' : sig(a.mejor_pct, 1) + ' / ' + sig(a.peor_pct, 1) + ' %'}</td>
          <td>${ab.length ? ab.length + ' (' + gan + ' ganando)' : '—'}</td></tr>`;
      }).join('') + '</tbody></table><p class="nota">Factor = lo que ganó ÷ lo que perdió en las operaciones cerradas (más de 1 = gana más de lo que pierde). Se completa a medida que los robots cierran operaciones.</p>'
      : '<p class="nota">Sin datos todavía.</p>';
    const abi = datos.abiertas || [];
    R('rbAbiertas').innerHTML = abi.length ? '<table><thead><tr><th>Robot</th><th>Moneda</th><th>Lado</th><th>Va</th></tr></thead><tbody>' +
      abi.map(x => `<tr><td>${escR(x.bot)}</td><td>${escR(x.moneda)}</td><td class="${x.lado === 'corto' ? 'down' : 'up'}">${escR(x.lado)}</td><td class="${x.va_pct >= 0 ? 'up' : 'down'}">${sig(x.va_pct, 2)} %</td></tr>`).join('') + '</tbody></table>'
      : '<p class="nota">Ninguna posición abierta.</p>';
    const bit = datos.bitacora || [];
    R('rbBitacora').innerHTML = bit.length ? '<table><thead><tr><th>Robot</th><th>Moneda</th><th>Lado</th><th>Entrada → salida</th><th>Resultado</th><th>Por qué salió</th></tr></thead><tbody>' +
      bit.slice(0, 80).map(x => `<tr><td>${escR(x.bot)}</td><td>${escR(x.moneda)}</td><td>${escR(x.lado)}</td>
        <td>${escR(String(x.entrada).slice(5, 16).replace('T', ' '))} → ${escR(String(x.salida).slice(5, 16).replace('T', ' '))}</td>
        <td class="${x.resultado_usdt >= 0 ? 'up' : 'down'}">${sig(x.resultado_pct, 2)} % (${sig(x.resultado_usdt, 2)})</td><td style="text-align:left">${escR(x.motivo || '')}</td></tr>`).join('') + '</tbody></table>'
      : '<p class="nota">Todavía ninguna operación cerrada: aparecen acá cuando cada robot cierra una posición.</p>';
    const mem = datos.memoria || {operaciones: 0, lecciones: [], evitadas: []};
    const ev = mem.evitadas || [], evaluadas = ev.filter(x => x.habria_pct != null), bienEvitadas = evaluadas.filter(x => x.habria_pct < 0).length;
    R('rbMemoriaTexto').innerHTML = `El Robot 5 recuerda <b>${mem.operaciones}</b> operaciones cerradas con su contexto (subida de 4 h, % de compras, fuerza de las noticias,
      agitación y BTC). Antes de entrar busca las parecidas: si de 4 o más perdieron dos tercios y en promedio, <b>no entra</b>.
      ${evaluadas.length ? `De las entradas que frenó, en <b>${bienEvitadas} de ${evaluadas.length}</b> hizo bien (24 h después habría perdido).` : ''}
      ${mem.operaciones < 4 ? 'Todavía tiene pocas operaciones: la memoria empieza a actuar cuando junta varias parecidas.' : ''}`;
    R('rbLecciones').innerHTML = (mem.lecciones || []).length ? '<table><thead><tr><th style="text-align:left">Cuando opera…</th><th>Veces</th><th>Ganó</th><th>Promedio</th></tr></thead><tbody>' +
      mem.lecciones.map(l => `<tr><td style="text-align:left">${escR(l.cuando)}</td><td>${l.n}</td><td>${l.ganadoras_pct} %</td><td class="${l.media_pct >= 0 ? 'up' : 'down'}">${sig(l.media_pct, 2)} %</td></tr>`).join('') + '</tbody></table>'
      : '<p class="nota">Aparecen cuando hay 3 o más operaciones cerradas en una misma situación.</p>';
    R('rbEvitadas').innerHTML = ev.length ? '<table><thead><tr><th>Cuándo</th><th>Moneda</th><th>Lado</th><th style="text-align:left">Por qué no entró</th><th>Habría</th></tr></thead><tbody>' +
      ev.slice().reverse().slice(0, 40).map(x => `<tr><td>${escR(String(x.fecha).slice(5, 16).replace('T', ' '))}</td><td>${escR(x.moneda)}</td><td>${escR(x.lado)}</td>
        <td style="text-align:left">${escR(x.motivo)}</td><td class="${x.habria_pct == null ? '' : x.habria_pct < 0 ? 'up' : 'down'}">${x.habria_pct == null ? '⏳' : sig(x.habria_pct, 2) + ' % ' + (x.habria_pct < 0 ? '✅' : '❌')}</td></tr>`).join('') + '</tbody></table>'
      : '<p class="nota">Todavía no frenó ninguna entrada.</p>';

    // años
    const an = csv(datos.sim_anual);
    R('rbAnual').innerHTML = '<table><thead><tr><th>Año</th><th>Datos</th>' + cols.map(c => `<th>${c}</th>`).join('') + '</tr></thead><tbody>' +
      an.map(f => `<tr><td>${escR(f.anio)}</td><td style="text-align:left">${escR(f.datos)}</td>` + cols.map(c => `<td class="${+f[c] >= 0 ? 'up' : 'down'}" title="caída máxima ${escR(f[c + ' caída'])} %">${sig(+f[c])} %</td>`).join('') + '</tr>').join('') + '</tbody></table>';
  }

  R('rbForm').addEventListener('submit', e => { e.preventDefault(); abrir(R('rbClave').value, R('rbRecordar').checked); });
  R('rbSalir').addEventListener('click', () => { olvidarClave(); datos = null; R('rbContenido').style.display = 'none'; R('rbCandado').style.display = 'block'; R('rbClave').value = ''; });
  document.querySelectorAll('[data-periodo]').forEach(b => b.addEventListener('click', () => {
    periodo = b.dataset.periodo;
    document.querySelectorAll('[data-periodo]').forEach(x => x.classList.toggle('activa', x === b));
    dibujar();
  }));
  // al abrir la solapa: si ya se puso la clave, descifra solo; cada 10 min vuelve a bajar los datos
  const recordada = () => { try { return !!localStorage.getItem('panel.claveRobots'); } catch (e) { return false; } };
  window.abrirRobots = () => {
    const c = leerClave();
    if (c && !datos) abrir(c, recordada());
    else if (datos) setTimeout(() => { dibujar(); ['rbVivo', 'rbSim'].forEach(d => window.Plotly && Plotly.Plots.resize(d)); }, 50);
  };
  if (R('s-robots').classList.contains('activa')) window.abrirRobots();
  setInterval(() => { const c = leerClave(); if (c && datos) abrir(c, recordada()); }, 10 * 60 * 1000);
})();
