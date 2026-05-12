(function () {
  'use strict';

  const DISCHARGE_COLOR = '#1b5e20'; // dark green
  const DISCHARGE_LABEL = 'ССЕЕ — Разреждане';
  const GEN_SLICE_COUNT = 9; // indices 0-8: АЕЦ … Био ЕЦ

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
    if (!(discharge > 50)) return; // handles NaN, negative, and small values

    const genSum = points.slice(0, GEN_SLICE_COUNT)
                         .reduce((s, p) => s + (p ? parseFloat(Array.isArray(p) ? p[1] : p.y) : 0), 0);
    const pct    = (discharge / (genSum + discharge) * 100).toFixed(2).replace('.', ',');

    points.push({
      name:  DISCHARGE_LABEL + ' ' + pct + '%',
      y:     Math.round(discharge),
      color: DISCHARGE_COLOR
    });
  }

  // Add a row to the generation table on the right side of the page.
  // The table is built inside the getJSON callback — we intercept it to append our row.
  function addTableRow(discharge) {
    const table = document.getElementById('generation_per_type_table');
    if (!table) return;
    const mw = Math.round(discharge);
    const tr = document.createElement('tr');
    tr.style.cssText = 'background:#e8f5e9;font-weight:bold;';
    tr.innerHTML =
      '<td style="color:' + DISCHARGE_COLOR + '">' + DISCHARGE_LABEL + '</td>' +
      '<td style="text-align:right;color:' + DISCHARGE_COLOR + '">' + mw + '</td>';
    table.appendChild(tr);
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

    // Patch getJSON only to add the table row (data array untouched)
    interceptProp(hc, 'getJSON', function (origFn) {
      return function (url, callback) {
        if (!url.includes('rabota_na_EEC_json')) {
          return origFn.call(hc, url, callback);
        }
        origFn.call(hc, url, function (data) {
          const discharge = calcDischarge(data);
          if (discharge > 50) {
            // Table row — appended after page's own rows are built
            setTimeout(function () { addTableRow(discharge); }, 0);
          }
          callback(data);
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
