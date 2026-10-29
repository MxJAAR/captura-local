const APP = {
  sheets: {
    login: 'Login',
    lines: 'Lineas',
    routes: 'Rutas',
    entries: 'Capturas'
  },
  properties: {
    spreadsheetId: 'CAPTURA_SPREADSHEET_ID',
    passwordPepper: 'CAPTURA_PASSWORD_PEPPER',
    captureEnabled: 'CAPTURA_ENABLED'
  },
  cacheSeconds: 21600,
  adminSessionMs: 8 * 60 * 60 * 1000,
  historyLimit: 30,
  adminPageSize: 10
};

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Captura MTA/MTB')
    .addItem('Preparar hojas de la aplicación', 'initializeApp')
    .addToUi();
}

function initializeApp() {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet) {
    throw new Error('Abre el proyecto desde la hoja de cálculo que almacenará los datos.');
  }

  const properties = PropertiesService.getScriptProperties();
  properties.setProperty(APP.properties.spreadsheetId, spreadsheet.getId());
  if (!properties.getProperty(APP.properties.passwordPepper)) {
    properties.setProperty(APP.properties.passwordPepper, Utilities.getUuid() + Utilities.getUuid());
  }
  if (properties.getProperty(APP.properties.captureEnabled) === null) {
    properties.setProperty(APP.properties.captureEnabled, 'true');
  }

  ensureLoginSheet_(spreadsheet);
  ensureSheet_(spreadsheet, APP.sheets.lines, ['ID', 'Línea', 'Activa']);
  ensureRouteSheet_(spreadsheet);
  ensureEntriesSheet_(spreadsheet);
  SpreadsheetApp.flush();
  touchData_();
}

function doGet() {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Captura MTA / MTB')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function login(username, password) {
  const normalizedUsername = String(username || '').trim().toLowerCase();
  const suppliedPassword = String(password || '');
  if (!normalizedUsername || !suppliedPassword) {
    throw new Error('Escribe tu usuario y contraseña.');
  }
  const user = findUser_(normalizedUsername);
  if (!user || !user.active || !passwordMatches_(user.password, suppliedPassword)) {
    throw new Error('Usuario o contraseña incorrectos.');
  }
  if (user.role !== 'admin') {
    throw new Error('Este acceso es solo para administradores. Usa la CaptureKey para capturar.');
  }

  const token = Utilities.getUuid() + Utilities.getUuid();
  const cache = CacheService.getScriptCache();
  const expiresAt = Date.now() + APP.adminSessionMs;
  pruneStoredSessions_();
  storeSession_(token, { username: user.username, role: 'admin', expiresAt: expiresAt });
  const selectedLine = cache.get(lineCacheKey_(user.username)) || '';
  return {
    token: token,
    username: user.username,
    role: user.role,
    expiresAt: expiresAt,
    serverNow: Date.now(),
    selectedLine: selectedLine
  };
}

function authorizeCaptureKey(key, clientId) {
  const suppliedKey = String(key || '');
  if (!suppliedKey) throw new Error('Escribe tu CaptureKey.');
  const captureKey = getCaptureKey_();
  if (!captureKey || suppliedKey !== captureKey) throw new Error('CaptureKey incorrecta.');
  const client = String(clientId || '').toLowerCase();
  if (!/^[a-f0-9-]{16,80}$/.test(client)) {
    throw new Error('No se pudo identificar este dispositivo. Recarga la página e inténtalo nuevamente.');
  }
  const username = 'captura:' + client;
  const cache = CacheService.getScriptCache();
  const token = Utilities.getUuid() + Utilities.getUuid();
  pruneStoredSessions_();
  storeSession_(token, {
    role: 'captura',
    username: username,
    captureKeyHash: keyHash_(captureKey),
    keyVersion: PropertiesService.getScriptProperties().getProperty('CAPTURA_KEY_VERSION') || 'initial'
  });
  return {
    token: token,
    username: username,
    role: 'captura',
    selectedLine: cache.get(lineCacheKey_(username)) || ''
  };
}

function logout(token) {
  if (token) {
    CacheService.getScriptCache().remove(sessionCacheKey_(String(token)));
    PropertiesService.getScriptProperties().deleteProperty(storedSessionKey_(String(token)));
  }
  return true;
}

function getAppData(token, options) {
  const user = requireSession_(token);
  const opts = options || {};
  const status = syncState_();
  status.sessionExpiresAt = user.expiresAt || null;
  status.serverNow = Date.now();
  const cache = CacheService.getScriptCache();
  let selectedLine = typeof opts.line === 'string' ? opts.line : cache.get(lineCacheKey_(user.username)) || '';
  const version = captureVersion_(status, selectedLine);
  if (opts.version === version) return Object.assign({ unchanged: true, version: version }, status);
  const catalogs = catalogData_(status);
  if (!catalogs.lines.some(function (line) { return line.name === selectedLine; })) selectedLine = '';
  const history = selectedLine ? cachedJson_('history:v3:' + version + ':' + keyHash_(selectedLine), function () {
    const result = readLineHistory_(selectedLine);
    const line = catalogs.lines.find(function (item) { return item.name === selectedLine; });
    result.completedRouteIds = readCompletionRows_(status.epoch).filter(function (row) {
      return String(row[1]) === line.id && row[4] === true;
    }).map(function (row) { return String(row[2]); });
    return result;
  }) : { entries: [], routeIds: [], totals: { mta: 0, mtb: 0 }, routeTotals: {}, completedRouteIds: [] };
  return Object.assign({}, status, catalogs, {
    username: user.username, role: user.role, selectedLine: selectedLine,
    version: version, history: history.entries, routeIdsWithEntries: history.routeIds,
    lineTotals: history.totals, routeTotals: history.routeTotals, completedRouteIds: history.completedRouteIds
  });
}

function setSelectedLine(token, lineName) {
  const user = requireSession_(token);
  const name = String(lineName || '');
  const exists = readRecords_(APP.sheets.lines).some(function (row) {
    return String(row[1]) === name;
  });
  if (name && !exists) {
    throw new Error('La línea seleccionada ya no está disponible.');
  }
  const cache = CacheService.getScriptCache();
  if (name) {
    cache.put(lineCacheKey_(user.username), name, APP.cacheSeconds);
  } else {
    cache.remove(lineCacheKey_(user.username));
  }
  return name;
}

function saveEntry(token, payload) {
  requireSession_(token);
  const data = payload || {};
  const completion = data.kind === 'completion';
  if (data.complete !== undefined && data.complete !== null && typeof data.complete !== 'boolean') throw new Error('VALIDATION: Estado de ruta inválido.');
  if (data.kind && data.kind !== 'entry' && !completion) throw new Error('VALIDATION: Tipo de operación inválido.');
  if (completion && typeof data.complete !== 'boolean') throw new Error('VALIDATION: Estado de ruta inválido.');
  const mta = parseQuantity_(data.mta), mtb = parseQuantity_(data.mtb);
  if (!completion && mta === '' && mtb === '') throw new Error('VALIDATION: Ingresa MTA, MTB o ambos.');
  if (!/^[a-f0-9-]{36}$/i.test(String(data.operationId || ''))) throw new Error('VALIDATION: Actualiza la página para enviar.');
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) throw new Error('BUSY: El servidor está ocupado.');
  try {
    requireSession_(token);
    recoverPendingSave_();
    const status = syncState_();
    if (String(data.epoch) !== status.epoch) throw new Error('RESET: Esta captura pertenece a una jornada anterior.');
    const operations = operationsSheet_();
    const existing = findRecordRow_(operations, data.operationId);
    if (existing) {
      const receipt = JSON.parse(operations.getRange(existing, 3).getValue());
      if (operationSignature_(JSON.parse(receipt.request)) !== operationSignature_(data)) {
        throw new Error('VALIDATION: Identificador de envío reutilizado.');
      }
      return receipt.result;
    }
    if (!status.captureEnabled) throw new Error('PAUSED: La captura está pausada por el administrador.');
    if (completion) {
      const catalogs = catalogData_(status);
      const line = catalogs.lines.find(function (item) { return item.name === String(data.line); });
      const route = catalogs.routes.find(function (item) { return item.id === String(data.routeId); });
      if (!line || !route) throw new Error('VALIDATION: La línea o ruta ya no está disponible.');
      const result = { kind: 'completion', line: line.name, routeId: route.id, complete: data.complete, epoch: status.epoch };
      return commitOperation_(operations, data, {
        completion: [keyHash_(JSON.stringify([line.id, route.id])), line.id, route.id, status.epoch, data.complete, new Date()],
        result: result
      });
    }
    const sheet = getSheet_(APP.sheets.entries);
    let row;
    if (data.id) {
      const rowNumber = findEntryRow_(sheet, String(data.id));
      if (!rowNumber) throw new Error('VALIDATION: La entrada ya no existe.');
      row = sheet.getRange(rowNumber, 1, 1, 8).getValues()[0];
      row[6] = mta; row[7] = mtb;
    } else {
      const catalogs = catalogData_(status);
      const route = catalogs.routes.find(function (r) { return r.id === String(data.routeId); });
      if (!route || !catalogs.lines.some(function (l) { return l.name === String(data.line); })) {
        throw new Error('VALIDATION: La línea o ruta ya no está disponible.');
      }
      row = [data.operationId, new Date(), '', String(data.line), route.id, route.name, mta, mtb];
    }
    const result = { entry: entryObject_(row), updated: !!data.id, epoch: status.epoch };
    const receipt = { row: row, result: result };
    if (typeof data.complete === 'boolean') {
      const catalogs = catalogData_(status);
      const line = catalogs.lines.find(function (item) { return item.name === String(row[3]); });
      const route = catalogs.routes.find(function (item) { return item.id === String(row[4]); });
      if (!line || !route) throw new Error('VALIDATION: La línea o ruta ya no está disponible.');
      receipt.completion = [keyHash_(JSON.stringify([line.id, route.id])), line.id, route.id, status.epoch, data.complete, new Date()];
      result.complete = data.complete; result.line = line.name; result.routeId = route.id;
    }
    return commitOperation_(operations, data, receipt);
  } finally { lock.releaseLock(); }
}

// Compare semantic fields in a fixed order: transport may reorder keys or normalize numeric types.
// Applying this to both sides also supports receipts written by previous versions.
function operationSignature_(data) {
  return JSON.stringify({
    kind: data.kind || 'entry',
    complete: typeof data.complete === 'boolean' ? data.complete : null,
    operationId: String(data.operationId || ''),
    epoch: String(data.epoch || ''),
    id: String(data.id || ''),
    line: String(data.line || ''),
    routeId: String(data.routeId || ''),
    mta: parseQuantity_(data.mta),
    mtb: parseQuantity_(data.mtb)
  });
}

function deleteEntry(token, entryId) {
  requireSession_(token);
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    recoverPendingSave_();
    if (PropertiesService.getScriptProperties().getProperty(APP.properties.captureEnabled) === 'false') {
      throw new Error('La captura está pausada por el administrador.');
    }
    const sheet = getSheet_(APP.sheets.entries);
    const rowNumber = findEntryRow_(sheet, String(entryId || ''));
    if (!rowNumber) {
      throw new Error('La entrada ya no existe. Actualiza el historial.');
    }
    sheet.deleteRow(rowNumber);
    return true;
  } finally {
    try { SpreadsheetApp.flush(); touchData_(); } finally { lock.releaseLock(); }
  }
}

function getAdminDashboard(token, options) {
  const user = requireAdmin_(token);
  const opts = options || {};
  const status = syncState_();
  status.sessionExpiresAt = user.expiresAt;
  status.serverNow = Date.now();
  const page = Math.max(1, Math.floor(Number(opts.page) || 1));
  const filter = { line: String(opts.line || ''), route: String(opts.route || ''), page: page };
  const version = 'completion-v1:page-' + APP.adminPageSize + ':' + status.revision + ':' + status.bucket + ':' + keyHash_(JSON.stringify(filter));
  if (opts.version === version) return Object.assign({ unchanged: true, version: version }, status);
  const dashboard = cachedJson_('dashboard:' + version, function () { return buildDashboard_(filter); });
  return Object.assign({}, dashboard, status, { version: version, captureKey: getCaptureKey_() });
}

function buildDashboard_(filter) {
  const lines = readRecords_(APP.sheets.lines);
  const routes = readRecords_(APP.sheets.routes);
  const entries = readRecords_(APP.sheets.entries);
  const completed = {};
  const totals = {};
  const entryLines = {};
  const entryRoutes = {};
  readCompletionRows_(syncState_().epoch).forEach(function (row) {
    if (row[4] === true) completed[JSON.stringify([String(row[1]), String(row[2])])] = true;
  });

  entries.forEach(function (row) {
    const routeName = String(row[5]);
    entryLines[String(row[3])] = true;
    entryRoutes[routeName] = true;
    if (!totals[routeName]) {
      totals[routeName] = { route: routeName, mta: 0, mtb: 0 };
    }
    totals[routeName].mta += Number(row[6]) || 0;
    totals[routeName].mtb += Number(row[7]) || 0;
  });

  const lineProgress = lines.map(function (line) {
    const lineName = String(line[1]);
    const done = routes.filter(function (route) {
      return completed[JSON.stringify([String(line[0]), String(route[0])])];
    }).length;
    return {
      line: lineName,
      total: routes.length,
      completed: done,
      percent: routes.length ? Math.round(done * 100 / routes.length) : 0
    };
  });

  return {
    lineProgress: lineProgress,
    routeTotals: Object.keys(totals).sort().map(function (key) { return totals[key]; }),
    entryLines: Object.keys(entryLines).sort(),
    entryRoutes: Object.keys(entryRoutes).sort(),
    ...pageEntries_(entries, filter),
    lines: lines.map(function (row) {
      return { id: String(row[0]), name: String(row[1]), active: true };
    }),
    routes: routes.map(function (row) {
      return { id: String(row[0]), name: String(row[1]), active: true };
    }),
    captureEnabled: PropertiesService.getScriptProperties().getProperty(APP.properties.captureEnabled) !== 'false'
  };
}

function adminSaveLine(token, payload) {
  requireAdmin_(token);
  const data = payload || {};
  const names = splitCatalogNames_(data.name, 'línea');
  if (data.id && names.length !== 1) throw new Error('Solo puedes cambiar el nombre de una línea a la vez.');
  const name = names[0];
  const id = String(data.id || '');
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  let addedCount = 0;
  try {
    recoverPendingSave_();
    const sheet = getSheet_(APP.sheets.lines);
    const records = readRecords_(APP.sheets.lines);
    ensureUniqueCatalogNames_(names, records, 'línea', id);
    if (id) {
      const rowNumber = findRecordRow_(sheet, id);
      if (!rowNumber) throw new Error('La línea ya no existe. Actualiza el panel.');
      const previousName = String(sheet.getRange(rowNumber, 2).getValue());
      if (previousName !== name) {
        const entriesSheet = getSheet_(APP.sheets.entries);
        const entries = readRecords_(APP.sheets.entries);
        if (entries.length) {
          entriesSheet.getRange(2, 4, entries.length, 1).setValues(entries.map(function (entry) {
            return [String(entry[3]) === previousName ? name : entry[3]];
          }));
        }
      }
      sheet.getRange(rowNumber, 2, 1, 2).setValues([[name, true]]);
    } else {
      sheet.getRange(sheet.getLastRow() + 1, 1, names.length, 3).setValues(names.map(function (item) {
        return [Utilities.getUuid(), item, true];
      }));
      addedCount = names.length;
    }
  } finally {
    try { SpreadsheetApp.flush(); touchData_(); } finally { lock.releaseLock(); }
  }
  return { catalogAdded: addedCount || 1 };
}

function adminSaveRoute(token, payload) {
  requireAdmin_(token);
  const data = payload || {};
  const names = splitCatalogNames_(data.name, 'ruta');
  if (data.id && names.length !== 1) throw new Error('Solo puedes cambiar el nombre de una ruta a la vez.');
  const name = names[0];
  const id = String(data.id || '');
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  let addedCount = 0;
  try {
    recoverPendingSave_();
    const sheet = getSheet_(APP.sheets.routes);
    const records = readRecords_(APP.sheets.routes);
    ensureUniqueCatalogNames_(names, records, 'ruta', id);
    if (id) {
      const rowNumber = findRecordRow_(sheet, id);
      if (!rowNumber) throw new Error('La ruta ya no existe. Actualiza el panel.');
      sheet.getRange(rowNumber, 2, 1, 2).setValues([[name, true]]);
    } else {
      sheet.getRange(sheet.getLastRow() + 1, 1, names.length, 3).setValues(names.map(function (item) {
        return [Utilities.getUuid(), item, true];
      }));
      addedCount = names.length;
    }
  } finally {
    try { SpreadsheetApp.flush(); touchData_(); } finally { lock.releaseLock(); }
  }
  return { catalogAdded: addedCount || 1 };
}

function splitCatalogNames_(value, label) {
  const parts = String(value || '').split(/[,\r\n]+/).map(function (name) {
    return name.trim();
  }).filter(function (name) {
    return name !== '';
  });
  if (!parts.length) throw new Error('Escribe al menos un nombre de ' + label + '.');
  return parts.map(function (name) { return cleanName_(name, label); });
}

function ensureUniqueCatalogNames_(names, records, label, currentId) {
  const seen = {};
  names.forEach(function (name) {
    const normalizedName = name.toLowerCase();
    if (seen[normalizedName]) {
      throw new Error('El nombre "' + name + '" está repetido en la lista de ' + label + 's.');
    }
    seen[normalizedName] = true;
    const exists = records.some(function (row) {
      return String(row[1]).toLowerCase() === normalizedName && String(row[0]) !== currentId;
    });
    if (exists) throw new Error('Ya existe una ' + label + ' con el nombre "' + name + '".');
  });
}

function adminSaveCaptureKey(token, captureKey) {
  requireAdmin_(token);
  const key = String(captureKey || '');
  if (key.length > 100) throw new Error('La CaptureKey no puede superar los 100 caracteres.');

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const keyCell = getSheet_(APP.sheets.login).getRange(2, 5);
    if (String(keyCell.getValue() || '') !== key) {
      PropertiesService.getScriptProperties().setProperty('CAPTURA_KEY_VERSION', Utilities.getUuid());
    }
    keyCell.setNumberFormat('@');
    keyCell.setValue(key);
  } finally {
    try { SpreadsheetApp.flush(); touchData_(); } finally { lock.releaseLock(); }
  }
  return { ok: true };
}

function adminDeleteLine(token, lineId) {
  requireAdmin_(token);
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    recoverPendingSave_();
    const sheet = getSheet_(APP.sheets.lines);
    const rowNumber = findRecordRow_(sheet, String(lineId || ''));
    if (!rowNumber) throw new Error('La línea ya no existe. Actualiza el panel.');
    sheet.deleteRow(rowNumber);
  } finally {
    try { SpreadsheetApp.flush(); touchData_(); } finally { lock.releaseLock(); }
  }
  return { ok: true };
}

function adminDeleteRoute(token, routeId) {
  requireAdmin_(token);
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    recoverPendingSave_();
    const sheet = getSheet_(APP.sheets.routes);
    const rowNumber = findRecordRow_(sheet, String(routeId || ''));
    if (!rowNumber) throw new Error('La ruta ya no existe. Actualiza el panel.');
    sheet.deleteRow(rowNumber);
  } finally {
    try { SpreadsheetApp.flush(); touchData_(); } finally { lock.releaseLock(); }
  }
  return { ok: true };
}

function adminDeleteCatalogItems(token, type, ids) {
  requireAdmin_(token);
  if (type !== 'line' && type !== 'route') throw new Error('Catálogo inválido.');
  if (!Array.isArray(ids) || !ids.length || ids.some(function (id) { return typeof id !== 'string' || !id || id.length > 100; })) {
    throw new Error('Selecciona al menos un registro válido.');
  }
  const selected = new Set(ids);
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    requireAdmin_(token);
    recoverPendingSave_();
    const sheet = getSheet_(type === 'line' ? APP.sheets.lines : APP.sheets.routes);
    const rows = readSheetRecords_(sheet, 1).reduce(function (result, row, index) {
      if (selected.has(String(row[0]))) result.push(index + 2);
      return result;
    }, []).reverse();
    // Delete contiguous blocks from bottom to top so row numbers remain stable.
    for (let index = 0; index < rows.length;) {
      const end = rows[index];
      let start = end;
      while (++index < rows.length && rows[index] === start - 1) start = rows[index];
      sheet.deleteRows(start, end - start + 1);
    }
    return { deletedCount: rows.length };
  } finally {
    try { SpreadsheetApp.flush(); touchData_(); } finally { lock.releaseLock(); }
  }
}

function setCaptureEnabled(token, enabled) {
  requireAdmin_(token);
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    recoverPendingSave_();
    PropertiesService.getScriptProperties().setProperty(APP.properties.captureEnabled, enabled === true ? 'true' : 'false');
    touchData_();
    return enabled === true;
  } finally { lock.releaseLock(); }
}

function resetCapture(token) {
  requireAdmin_(token);
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    recoverPendingSave_();
    PropertiesService.getScriptProperties().setProperty('CAPTURA_EPOCH', Utilities.getUuid());
    const sheet = getSheet_(APP.sheets.entries);
    const lastRow = sheet.getLastRow();
    if (lastRow > 1) {
      sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).clearContent();
    }
    // Old receipts are no longer needed: requests from the old epoch are rejected before lookup.
    const operations = operationsSheet_();
    if (operations.getLastRow() > 1) operations.getRange(2, 1, operations.getLastRow() - 1, 3).clearContent();
    const completionSheet = getSpreadsheet_().getSheetByName('EstadoRutas');
    if (completionSheet && completionSheet.getLastRow() > 1) completionSheet.getRange(2, 1, completionSheet.getLastRow() - 1, 6).clearContent();
  } finally {
    try { SpreadsheetApp.flush(); touchData_(); } finally { lock.releaseLock(); }
  }
  return true;
}

function exportEntries(token) {
  requireAdmin_(token);
  const rows = readRecords_(APP.sheets.entries);
  const totals = {};
  readRecords_(APP.sheets.routes).forEach(function (row) {
    totals[String(row[1])] = { mta: 0, mtb: 0 };
  });
  rows.forEach(function (row) {
    const route = String(row[5]);
    if (!totals[route]) totals[route] = { mta: 0, mtb: 0 };
    totals[route].mta += Number(row[6]) || 0;
    totals[route].mtb += Number(row[7]) || 0;
  });
  const csvRows = [['Ruta', 'Total MTA', 'Total MTB']];
  Object.keys(totals).sort().forEach(function (route) {
    csvRows.push([route, totals[route].mta, totals[route].mtb]);
  });
  return '\uFEFF' + csvRows.map(function (row) {
    return row.map(csvCell_).join(',');
  }).join('\r\n');
}

function ensureSheet_(spreadsheet, name, headers) {
  let sheet = spreadsheet.getSheetByName(name);
  if (!sheet) sheet = spreadsheet.insertSheet(name);
  const current = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
  const empty = current.every(function (value) { return value === ''; });
  if (empty) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
  } else if (headers.some(function (header, index) { return current[index] !== header; })) {
    throw new Error('La hoja "' + name + '" ya existe con encabezados distintos. Revisa la fila 1 antes de continuar.');
  }
  return sheet;
}

function ensureEntriesSheet_(spreadsheet) {
  const headers = ['ID', 'Fecha', 'Sin identificador', 'Línea', 'Ruta ID', 'Ruta', 'MTA', 'MTB'];
  let sheet = spreadsheet.getSheetByName(APP.sheets.entries);
  if (!sheet) sheet = spreadsheet.insertSheet(APP.sheets.entries);
  const current = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
  const empty = current.every(function (header) { return header === ''; });
  if (empty) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    const lastRow = sheet.getLastRow();
    if (lastRow > 1) sheet.getRange(2, 3, lastRow - 1, 1).clearContent();
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
    return sheet;
  }

  const legacyHeaders = headers.slice();
  legacyHeaders[2] = 'Usuario';
  const matchesCurrent = headers.every(function (header, index) { return current[index] === header; });
  const matchesLegacy = legacyHeaders.every(function (header, index) { return current[index] === header; });
  if (!matchesCurrent && !matchesLegacy) {
    throw new Error('La hoja "Capturas" ya existe con encabezados distintos. Revisa la fila 1 antes de continuar.');
  }

  const lastRow = sheet.getLastRow();
  if (lastRow > 1) sheet.getRange(2, 3, lastRow - 1, 1).clearContent();
  if (matchesLegacy) {
    sheet.getRange(1, 3).setValue(headers[2]);
    sheet.getRange(1, 3).setFontWeight('bold');
  }
  sheet.setFrozenRows(1);
  return sheet;
}

function ensureLoginSheet_(spreadsheet) {
  const sheet = spreadsheet.getSheetByName(APP.sheets.login) || spreadsheet.insertSheet(APP.sheets.login);
  const headers = sheet.getRange(1, 1, 1, 5).getValues()[0];
  const empty = headers.every(function (value) { return value === ''; });
  if (empty) {
    sheet.getRange(1, 1, 1, 5).setValues([['Usuario', 'Contraseña', 'Rol', 'Activo', 'CaptureKey']]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, 5).setFontWeight('bold');
    return sheet;
  }

  if (headers[0] !== 'Usuario' || headers[1] !== 'Contraseña') {
    throw new Error('La hoja "Login" tiene encabezados distintos. Revisa la fila 1 antes de continuar.');
  }
  const expected = ['Rol', 'Activo'];
  expected.forEach(function (header, index) {
    const column = index + 3;
    if (headers[column - 1] === '') {
      sheet.getRange(1, column).setValue(header);
      sheet.getRange(1, column).setFontWeight('bold');
    } else if (headers[column - 1] !== header) {
      throw new Error('La columna ' + String.fromCharCode(64 + column) + ' de "Login" debe tener el encabezado ' + header + '.');
    }
  });
  const lastRow = sheet.getLastRow();
  const firstCell = String(sheet.getRange(1, 5).getValue() || '');
  const existingValues = lastRow > 1 ? sheet.getRange(2, 5, lastRow - 1, 1).getValues() : [];
  let captureKey = firstCell === 'CaptureKey' ? '' : firstCell;
  for (let index = 0; index < existingValues.length && !captureKey; index++) {
    captureKey = String(existingValues[index][0] || '');
  }
  sheet.getRange(1, 5).setValue('CaptureKey');
  sheet.getRange(1, 5).setFontWeight('bold');
  sheet.getRange(2, 5).setNumberFormat('@');
  sheet.getRange(2, 5).setValue(captureKey);
  if (lastRow > 2) sheet.getRange(3, 5, lastRow - 2, 1).clearContent();
  sheet.setFrozenRows(1);
  return sheet;
}

function ensureRouteSheet_(spreadsheet) {
  let sheet = spreadsheet.getSheetByName(APP.sheets.routes);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(APP.sheets.routes);
    sheet.getRange(1, 1, 1, 3).setValues([['ID', 'Ruta', 'Activa']]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, 3).setFontWeight('bold');
    return sheet;
  }

  const headers = sheet.getRange(1, 1, 1, 4).getValues()[0];
  if (headers[0] === 'ID' && headers[1] === 'Ruta' && headers[2] === 'Activa') {
    return sheet;
  }
  if (headers[0] !== 'ID' || headers[1] !== 'Línea' || headers[2] !== 'Ruta' || headers[3] !== 'Activa') {
    throw new Error('La hoja "Rutas" tiene encabezados distintos. Revisa la fila 1 antes de continuar.');
  }

  const oldRoutes = readSheetRecords_(sheet, 4);
  const routeByName = {};
  const routeIdMap = {};
  oldRoutes.forEach(function (row) {
    const name = String(row[2] || '').trim();
    if (!name) return;
    const key = name.toLowerCase();
    if (!routeByName[key]) {
      routeByName[key] = { id: Utilities.getUuid(), name: name, active: false };
    }
    if (isActive_(row[3])) routeByName[key].active = true;
    routeIdMap[String(row[0])] = { id: routeByName[key].id, name: routeByName[key].name };
  });

  const routes = Object.keys(routeByName).map(function (key) {
    const route = routeByName[key];
    return [route.id, route.name, route.active];
  });

  const entriesSheet = spreadsheet.getSheetByName(APP.sheets.entries);
  if (entriesSheet && entriesSheet.getLastRow() > 1) {
    const entries = entriesSheet.getRange(2, 1, entriesSheet.getLastRow() - 1, 8).getValues();
    const updatedRouteValues = entries.map(function (row) {
      const mappedRoute = routeIdMap[String(row[4])];
      return mappedRoute ? [mappedRoute.id, mappedRoute.name] : [row[4], row[5]];
    });
    entriesSheet.getRange(2, 5, updatedRouteValues.length, 2).setValues(updatedRouteValues);
  }

  if (sheet.getLastRow() > 1) {
    sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).clearContent();
  }
  sheet.getRange(1, 1, 1, 3).setValues([['ID', 'Ruta', 'Activa']]);
  sheet.getRange(1, 4).clearContent();
  if (routes.length) sheet.getRange(2, 1, routes.length, 3).setValues(routes);
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, 3).setFontWeight('bold');
  return sheet;
}

let executionSpreadsheet_;
function getSpreadsheet_() {
  if (executionSpreadsheet_) return executionSpreadsheet_;
  const id = PropertiesService.getScriptProperties().getProperty(APP.properties.spreadsheetId);
  if (!id) throw new Error('La aplicación aún no está preparada. Ejecuta initializeApp desde la hoja de cálculo.');
  executionSpreadsheet_ = SpreadsheetApp.openById(id);
  return executionSpreadsheet_;
}

function getSheet_(name) {
  const sheet = getSpreadsheet_().getSheetByName(name);
  if (!sheet) throw new Error('No se encontró la hoja "' + name + '". Ejecuta initializeApp.');
  return sheet;
}

function readRecords_(sheetName) {
  const sheet = getSheet_(sheetName);
  return readSheetRecords_(sheet, sheet.getLastColumn());
}

function readSheetRecords_(sheet, columnCount) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  return sheet.getRange(2, 1, lastRow - 1, columnCount).getValues();
}

function readLineHistory_(lineName) {
  const sheet = getSheet_(APP.sheets.entries);
  const lastRow = sheet.getLastRow();
  const history = [];
  const routes = {};
  const totals = { mta: 0, mtb: 0 };
  const routeTotals = {};
  const chunkSize = 500;
  for (let end = lastRow; end >= 2; end -= chunkSize) {
    const start = Math.max(2, end - chunkSize + 1);
    const values = sheet.getRange(start, 1, end - start + 1, 8).getValues();
    for (let index = values.length - 1; index >= 0; index--) {
      const row = values[index];
      if (String(row[3]) === lineName) {
        totals.mta += Number(row[6]) || 0;
        totals.mtb += Number(row[7]) || 0;
        const routeId = String(row[4]);
        routes[routeId] = true;
        if (!routeTotals[routeId]) routeTotals[routeId] = { mta: 0, mtb: 0, count: 0 };
        routeTotals[routeId].count++;
        routeTotals[routeId].mta += Number(row[6]) || 0;
        routeTotals[routeId].mtb += Number(row[7]) || 0;
        if (history.length < APP.historyLimit) {
          history.push({
            id: String(row[0]),
            date: row[1] instanceof Date ? row[1].toISOString() : String(row[1]),
            line: String(row[3]),
            routeId: String(row[4]),
            route: String(row[5]),
            mta: row[6] === '' ? '' : Number(row[6]),
            mtb: row[7] === '' ? '' : Number(row[7])
          });
        }
      }
    }
  }
  return { entries: history, routeIds: Object.keys(routes), totals: totals, routeTotals: routeTotals };
}

function requireSession_(token) {
  token = String(token || '');
  const cache = CacheService.getScriptCache();
  const properties = PropertiesService.getScriptProperties();
  const cached = cache.get(sessionCacheKey_(token));
  let record = cached && cached.indexOf('v2:') === 0 ? cached.substring(3) : properties.getProperty(storedSessionKey_(token));
  // Existing valid capture sessions can migrate without asking for the shared key again.
  if (!record && cached && cached.indexOf('capture-session:') === 0) {
    const old = JSON.parse(cached.substring('capture-session:'.length));
    if (old.username && old.key === getCaptureKey_()) {
      const migrated = { username: old.username, role: 'captura', captureKeyHash: keyHash_(old.key), keyVersion: properties.getProperty('CAPTURA_KEY_VERSION') || 'initial' };
      storeSession_(token, migrated);
      record = JSON.stringify(migrated);
    }
  }
  if (!record) throw new Error('Tu sesión expiró. Inicia sesión nuevamente.');
  let session;
  try { session = JSON.parse(record); } catch (_) { logout(token); throw new Error('La sesión no es válida. Inicia sesión nuevamente.'); }
  if (session.role === 'captura') {
    if (!session.username || session.captureKeyHash !== keyHash_(getCaptureKey_()) || session.keyVersion !== (properties.getProperty('CAPTURA_KEY_VERSION') || 'initial')) {
      logout(token);
      throw new Error('La CaptureKey fue modificada. Vuelve a validarla.');
    }
    if (!cached) cache.put(sessionCacheKey_(token), 'v2:' + record, APP.cacheSeconds);
    return { username: session.username, role: 'captura' };
  }
  if (session.role !== 'admin' || !Number.isFinite(session.expiresAt) || Date.now() >= session.expiresAt) {
    logout(token);
    throw new Error('Tu sesión de administrador expiró. Inicia sesión nuevamente; el acceso dura 8 horas.');
  }
  const user = findUser_(String(session.username || '').toLowerCase());
  if (!user || !user.active) {
    logout(token);
    throw new Error('La cuenta ya no está activa. Contacta al administrador.');
  }
  if (user.role !== 'admin') {
    logout(token);
    throw new Error('Esta sesión ya no tiene acceso. Inicia sesión nuevamente.');
  }
  if (!cached) cache.put(sessionCacheKey_(token), 'v2:' + record, Math.max(1, Math.min(APP.cacheSeconds, Math.ceil((session.expiresAt - Date.now()) / 1000))));
  return { username: user.username, role: user.role, expiresAt: session.expiresAt };
}

function storedSessionKey_(token) { return 'CAPTURA_SESSION_' + keyHash_(token); }

function storeSession_(token, session) {
  const record = JSON.stringify(session);
  PropertiesService.getScriptProperties().setProperty(storedSessionKey_(token), record);
  CacheService.getScriptCache().put(sessionCacheKey_(token), 'v2:' + record, APP.cacheSeconds);
}

function pruneStoredSessions_() {
  const properties = PropertiesService.getScriptProperties();
  const values = properties.getProperties();
  const keyHash = keyHash_(getCaptureKey_());
  const version = properties.getProperty('CAPTURA_KEY_VERSION') || 'initial';
  Object.keys(values).filter(function (key) { return key.indexOf('CAPTURA_SESSION_') === 0; }).forEach(function (key) {
    let session;
    try { session = JSON.parse(values[key]); } catch (_) { properties.deleteProperty(key); return; }
    if (session.role === 'admin' ? session.expiresAt <= Date.now() : session.captureKeyHash !== keyHash || session.keyVersion !== version) properties.deleteProperty(key);
  });
}

function requireAdmin_(token) {
  const user = requireSession_(token);
  if (user.role !== 'admin') throw new Error('No tienes permiso para realizar esta acción.');
  return user;
}

function findUser_(normalizedUsername) {
  const rows = readRecords_(APP.sheets.login);
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    if (String(row[0]).trim().toLowerCase() === normalizedUsername) {
      return {
        row: index + 2,
        username: String(row[0]).trim(),
        password: String(row[1] || ''),
        role: String(row[2] || '').trim().toLowerCase() === 'admin' ? 'admin' : 'usuario',
        active: row[3] === '' || row[3] === null ? true : isActive_(row[3])
      };
    }
  }
  return null;
}

function passwordMatches_(storedPassword, suppliedPassword) {
  if (isPasswordHash_(storedPassword)) {
    const pepper = PropertiesService.getScriptProperties().getProperty(APP.properties.passwordPepper);
    if (!pepper) return false;
    const expected = storedPassword.substring('hmac-sha256:'.length);
    return constantTimeEquals_(expected, hashPassword_(suppliedPassword));
  }
  return storedPassword === suppliedPassword;
}

function hashPassword_(password) {
  const pepper = PropertiesService.getScriptProperties().getProperty(APP.properties.passwordPepper);
  if (!pepper) throw new Error('Falta la configuración de seguridad. Ejecuta initializeApp.');
  return 'hmac-sha256:' + bytesToHex_(Utilities.computeHmacSha256Signature(password, pepper));
}

function isPasswordHash_(value) {
  return String(value).indexOf('hmac-sha256:') === 0;
}

function bytesToHex_(bytes) {
  return bytes.map(function (byte) {
    const value = byte < 0 ? byte + 256 : byte;
    return ('0' + value.toString(16)).slice(-2);
  }).join('');
}

function constantTimeEquals_(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function parseQuantity_(value) {
  if (value === '' || value === null || typeof value === 'undefined') return '';
  const text = String(value);
  if (!/^\d{1,3}$/.test(text)) {
    throw new Error('VALIDATION: Las cantidades deben tener únicamente números y máximo 3 dígitos.');
  }
  const quantity = Number(text);
  if (quantity < 0 || quantity > 999) {
    throw new Error('VALIDATION: La cantidad debe estar entre 0 y 999.');
  }
  return quantity;
}

function cleanName_(value, label) {
  const name = String(value || '').trim();
  if (!name || name.length > 100) {
    throw new Error('Escribe un nombre de ' + label + ' de 1 a 100 caracteres.');
  }
  return name;
}

function isActive_(value) {
  return value === true || String(value).toLowerCase() === 'true' || String(value) === '1';
}

function findRecordRow_(sheet, id) {
  if (!id || sheet.getLastRow() < 2) return 0;
  const match = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1)
    .createTextFinder(id)
    .matchEntireCell(true)
    .findNext();
  return match ? match.getRow() : 0;
}

function findEntryRow_(sheet, id) {
  return findRecordRow_(sheet, id);
}

function sessionCacheKey_(token) {
  return 'session:' + token;
}

function lineCacheKey_(username) {
  return 'line:' + username.toLowerCase();
}

function getCaptureKey_() {
  return String(getSheet_(APP.sheets.login).getRange(2, 5).getValue() || '');
}

function csvCell_(value) {
  const text = String(value === null || typeof value === 'undefined' ? '' : value);
  return '"' + text.replace(/"/g, '""') + '"';
}

function keyHash_(text) {
  return Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text)).slice(0, 32);
}
function syncState_() {
  const p = PropertiesService.getScriptProperties();
  return { epoch: p.getProperty('CAPTURA_EPOCH') || 'initial', revision: p.getProperty('CAPTURA_REVISION') || 'initial',
    controlRevision: p.getProperty('CAPTURA_CONTROL_REVISION') || 'initial',
    captureEnabled: p.getProperty(APP.properties.captureEnabled) !== 'false', bucket: Math.floor(Date.now() / 60000) };
}
function captureVersion_(status, line) {
  const lineKey = keyHash_(line);
  const lineRevision = PropertiesService.getScriptProperties().getProperty('CAPTURA_LINE_' + lineKey) || 'initial';
  return 'completion-v1:' + status.controlRevision + ':' + lineRevision + ':' + status.bucket + ':' + lineKey;
}
function touchData_(line) {
  const properties = PropertiesService.getScriptProperties();
  const revision = Utilities.getUuid();
  properties.setProperty('CAPTURA_REVISION', revision);
  properties.setProperty(line ? 'CAPTURA_LINE_' + keyHash_(line) : 'CAPTURA_CONTROL_REVISION', revision);
}
function cachedJson_(key, build) {
  const cache = CacheService.getScriptCache();
  const hit = cache.get(key);
  if (hit) { try { return JSON.parse(hit); } catch (_) {} }
  const value = build();
  const json = JSON.stringify(value);
  // Cache limit is bytes, not JS characters. Oversized results remain functional without caching.
  if (Utilities.newBlob(json).getBytes().length < 90000) cache.put(key, json, 60);
  return value;
}
function catalogData_(status) {
  return cachedJson_('catalogs:' + status.controlRevision + ':' + status.bucket, function () {
    function catalog(name) { return readRecords_(name).map(function (r) { return { id: String(r[0]), name: String(r[1]) }; }); }
    return { lines: catalog(APP.sheets.lines), routes: catalog(APP.sheets.routes) };
  });
}
function entryObject_(row) {
  return { id: String(row[0]), date: new Date(row[1]).toISOString(), line: String(row[3]),
    routeId: String(row[4]), route: String(row[5]), mta: row[6] === '' ? '' : Number(row[6]), mtb: row[7] === '' ? '' : Number(row[7]) };
}
function pageEntries_(rows, filter) {
  const matching = rows.filter(function (r) { return (!filter.line || String(r[3]) === filter.line) && (!filter.route || String(r[5]) === filter.route); }).reverse();
  const pages = Math.max(1, Math.ceil(matching.length / APP.adminPageSize));
  const page = Math.min(filter.page, pages);
  return { entries: matching.slice((page - 1) * APP.adminPageSize, page * APP.adminPageSize).map(entryObject_), page: page, pages: pages, totalEntries: matching.length };
}
function operationsSheet_() {
  const ss = getSpreadsheet_();
  let sheet = ss.getSheetByName('Operaciones');
  if (!sheet) {
    sheet = ss.insertSheet('Operaciones');
    sheet.appendRow(['ID', 'Estado', 'Recibo']);
    sheet.setFrozenRows(1);
  }
  return sheet;
}
function recoverPendingSave_() {
  const operations = operationsSheet_();
  const last = operations.getLastRow();
  // Only the last operation can be pending: every writer recovers it under the same script lock.
  if (last < 2 || operations.getRange(last, 2).getValue() !== 'pending') return;
  const receipt = JSON.parse(operations.getRange(last, 3).getValue());
  if (receipt.row) {
    const row = receipt.row;
    row[1] = new Date(row[1]);
    const sheet = getSheet_(APP.sheets.entries);
    const rowNumber = findEntryRow_(sheet, String(row[0]));
    if (rowNumber) sheet.getRange(rowNumber, 1, 1, 8).setValues([row]);
    else sheet.appendRow(row);
  }
  if (receipt.completion) {
    const row = receipt.completion;
    row[5] = new Date(row[5]);
    const sheet = ensureSheet_(getSpreadsheet_(), 'EstadoRutas', ['ID', 'Línea ID', 'Ruta ID', 'Jornada', 'Completa', 'Fecha']);
    const rowNumber = findRecordRow_(sheet, String(row[0]));
    if (rowNumber) sheet.getRange(rowNumber, 1, 1, 6).setValues([row]);
    else sheet.appendRow(row);
  }
  SpreadsheetApp.flush();
  touchData_(receipt.completion ? receipt.result.line : String(receipt.row[3]));
  operations.getRange(last, 2).setValue('done');
  SpreadsheetApp.flush();
}

function commitOperation_(operations, data, receipt) {
  receipt.request = operationSignature_(data);
  // Durable receipt: the next writer finishes an interrupted operation under the same lock.
  operations.appendRow([data.operationId, 'pending', JSON.stringify(receipt)]);
  SpreadsheetApp.flush();
  recoverPendingSave_();
  return receipt.result;
}

function readCompletionRows_(epoch) {
  const sheet = getSpreadsheet_().getSheetByName('EstadoRutas');
  if (!sheet) return [];
  return readSheetRecords_(sheet, 6).filter(function (row) { return String(row[3]) === epoch; });
}
