(function () {
  'use strict';

  const DISCHARGE_COLOR = '#81d4fa'; // lighter blue
  const DISCHARGE_LABEL = 'ССЕЕ — Разреждане';
  const IMPORT_COLOR    = '#7b1fa2'; // purple (pie slice only)
  const IMPORT_LABEL    = 'Внос';
  const BALANCE_LABEL   = 'Баланс внос/износ';
  const GEN_SLICE_COUNT = 9; // indices 0-8: АЕЦ … Био ЕЦ

  let pendingNetImport = null;

  // Back-calculate hidden discharge from server-embedded percentages.
  // ESO: pct = source_mw / total_including_discharge * 100
  // => implied_total = source_mw / (pct/100); discharge = implied_total - gen_sum
  function calcDischarge(points) {
    const implied = [];
    for (let i = 0; i < GEN_SLICE_COUNT; i++) {
      const p = points[i];
      if (!p) continue;
      const label = Array.isArray(p) ? p[0] : p.name;
      const value = Array.isArray(p) ? p[1] : p.y;
      const m = String(label).match(/(\d+[.,]\d+)%/);
      if (!m) continue;
      const pct = parseFloat(m[1].replace(',', '.'));
      const mw  = parseFloat(value);
      if (pct > 0 && mw > 0) implied.push(mw / (pct / 100));
    }
    if (!implied.length) return 0;
    const apiTotal = implied.reduce((a, b) => a + b) / implied.length;
    const genSum   = points.slice(0, GEN_SLICE_COUNT)
                           .reduce((s, p) => {
                             if (!p) return s;
                             const v = parseFloat(Array.isArray(p) ? p[1] : p.y);
                             return s + (isFinite(v) ? v : 0);
                           }, 0);
    const discharge = apiTotal - genSum;
    return isFinite(discharge) ? discharge : 0;
  }

  function patchPieSeries(series) {
    const points = series.data;
    if (!Array.isArray(points)) return;

    // Only act on the generation pie — check for percentage labels
    const isGenPie = points.some(function (p) {
      return p && String(Array.isArray(p) ? p[0] : p.name).match(/\d+[.,]\d+%/);
    });
    if (!isGenPie) return;

    const discharge = calcDischarge(points);
    if (!(discharge > 50)) return;

    // Add discharge slice (percentage will be recalculated below)
    points.push({ name: DISCHARGE_LABEL, y: Math.round(discharge), color: DISCHARGE_COLOR });

    const netImport = pendingNetImport;
    const effectiveImport = netImport || 0;
    if (effectiveImport > 50) {
      points.push({ name: IMPORT_LABEL, y: Math.round(effectiveImport), color: IMPORT_COLOR });
    }

    // Recalculate all percentages against the new total (supply side only)
    const newTotal = points.reduce((s, p) => {
      if (!p) return s;
      const v = parseFloat(Array.isArray(p) ? p[1] : p.y);
      return s + (isFinite(v) ? v : 0);
    }, 0);

    if (newTotal > 0) {
      points.forEach(function (p) {
        if (!p) return;
        const mw = parseFloat(Array.isArray(p) ? p[1] : p.y);
        if (!isFinite(mw) || mw <= 0) return;
        const newPct = (mw / newTotal * 100).toFixed(2).replace('.', ',');
        if (Array.isArray(p)) {
          p[0] = p[0].replace(/\s+\d+[.,]\d+%$/, '') + ' ' + newPct + '%';
        } else {
          p.name = p.name.replace(/\s+\d+[.,]\d+%$/, '') + ' ' + newPct + '%';
        }
      });
    }
  }

  // Add rows to the generation table then re-sort all rows by MW descending.
  // Preserves the original alternating row backgrounds. "Товар на РБ" pinned to bottom.
  function addTableRows(discharge, netImport, supplyTotal) {
    const table = document.getElementById('generation_per_type_table');
    if (!table) return;

    // Sample the two alternating background colors from the first two existing rows
    const existingRows = Array.from(table.querySelectorAll('tr')).filter(function (r) {
      return r.querySelectorAll('td').length >= 2;
    });
    const altBg = [
      existingRows[0] ? window.getComputedStyle(existingRows[0]).backgroundColor : '',
      existingRows[1] ? window.getComputedStyle(existingRows[1]).backgroundColor : ''
    ];

    // Discharge row — black bold, with percentage
    if (discharge > 50) {
      const pct = supplyTotal > 0 ? (discharge / supplyTotal * 100).toFixed(2).replace('.', ',') : '0,00';
      const tr = document.createElement('tr');
      tr.innerHTML =
        '<td style="font-weight:bold">' + DISCHARGE_LABEL + ' ' + pct + '%</td>' +
        '<td style="text-align:right;font-weight:bold">' + discharge.toFixed(2) + '</td>';
      table.appendChild(tr);
    }

    // Balance row — signed (positive = import, negative = export), pinned before load
    const balancePct = supplyTotal > 0 && netImport > 50
      ? (netImport / supplyTotal * 100).toFixed(2).replace('.', ',')
      : null;
    const balanceTr = document.createElement('tr');
    balanceTr.dataset.esoBalance = 'true';
    balanceTr.innerHTML =
      '<td style="font-weight:bold">' + BALANCE_LABEL + (balancePct ? ' ' + balancePct + '%' : '') + '</td>' +
      '<td style="text-align:right;font-weight:bold">' + netImport.toFixed(2) + '</td>';

    // Collect all rows; split into gen, balance+discharge (added by us), load
    const allRows = Array.from(table.querySelectorAll('tr')).filter(function (r) {
      return r.querySelectorAll('td').length >= 2;
    });
    const getMw = function (row) {
      return parseFloat(row.querySelectorAll('td')[1].textContent.replace(',', '.')) || 0;
    };
    const loadRows = allRows.filter(function (r) { return r.querySelector('td').textContent.includes('Товар'); });
    const genRows  = allRows.filter(function (r) { return !r.querySelector('td').textContent.includes('Товар') && !r.dataset.esoBalance; });

    // Apply strikethrough: when exporting, strike the smallest fossil/nuclear sources export can fully cover
    const isFossilOrNuclear = function (row) {
      const label = row.querySelector('td').textContent;
      return label.includes('АЕЦ') || label.includes('ТЕЦ');
    };
    const exportMw = netImport < 0 ? -netImport : 0;
    genRows.forEach(function (r) { r.style.textDecoration = ''; }); // reset
    if (exportMw > 0) {
      const candidates = genRows.filter(isFossilOrNuclear)
                                .slice().sort(function (a, b) { return getMw(a) - getMw(b); });
      let remaining = exportMw;
      candidates.forEach(function (r) {
        const v = getMw(r);
        if (remaining >= v) {
          r.style.textDecoration = 'line-through';
          remaining -= v;
        }
      });
    }

    // Sort all gen+discharge rows together descending by MW
    genRows.sort(function (a, b) { return getMw(b) - getMw(a); });

    // Re-insert: sorted (gen+discharge) → balance → load; alternate backgrounds across all
    const ordered = genRows.concat([balanceTr], loadRows);
    ordered.forEach(function (r, i) {
      r.style.backgroundColor = altBg[i % 2];
      table.appendChild(r);
    });
  }

  function interceptProp(obj, name, patchFn) {
    let _cur = obj[name] !== undefined ? patchFn(obj[name]) : undefined;
    Object.defineProperty(obj, name, {
      configurable: true,
      get() { return _cur; },
      set(v) { _cur = patchFn(v); }
    });
  }

  function patchHighcharts(hc) {
    if (!hc || hc.__esoPatched) return;
    hc.__esoPatched = true;

    // Patch getJSON: fetch flows in parallel, then fire original callback
    interceptProp(hc, 'getJSON', function (origFn) {
      return function (url, callback) {
        if (!url.includes('rabota_na_EEC_json')) {
          return origFn.call(hc, url, callback);
        }
        origFn.call(hc, url, function (data) {
          fetch('https://www.eso.bg/api/scada_live_json_pure.php')
            .then(function (r) { return r.json(); })
            .then(function (flows) {
              pendingNetImport = (flows.RO_data || 0) + (flows.SR_data || 0) +
                                 (flows.MK_data || 0) + (flows.GR_data || 0) +
                                 (flows.TR_data || 0);
            })
            .catch(function () { pendingNetImport = 0; })
            .finally(function () {
              const ni       = pendingNetImport || 0;
              const discharge = calcDischarge(data);
              const genSum   = data.slice(0, GEN_SLICE_COUNT).reduce(function (s, p) {
                if (!p) return s;
                const v = parseFloat(Array.isArray(p) ? p[1] : p.y);
                return s + (isFinite(v) ? v : 0);
              }, 0);
              const effectiveImport = ni;
              const supplyTotal = genSum + discharge + Math.max(0, effectiveImport);
              setTimeout(function () { addTableRows(discharge, ni, supplyTotal); }, 0);
              callback(data); // triggers Chart construction → patchPieSeries reads pendingNetImport
            });
        });
      };
    });

    // Patch Chart constructor to add the pie slice
    interceptProp(hc, 'Chart', function (OrigChart) {
      function PatchedChart(options) {
        if (options && options.series) {
          options.series.forEach(patchPieSeries);
        }
        return new OrigChart(options);
      }
      PatchedChart.prototype = OrigChart.prototype;
      return PatchedChart;
    });
  }

  let _hc;
  Object.defineProperty(window, 'Highcharts', {
    configurable: true,
    get() { return _hc; },
    set(val) {
      _hc = val;
      patchHighcharts(val);
    }
  });
})();
